import { randomUUID } from "node:crypto";
import type * as FeatureStore from "../feature-store";

/**
 * In-memory backend used by the feature regression tests.
 *
 * It replaces the storage layer (feature-store), the db module and the
 * audit/storage side effects with semantics equivalent to the real
 * PostgreSQL implementation:
 *
 * - `SELECT ... FOR UPDATE` is modeled as a per-row async lock queue, so
 *   concurrent transactions serialize exactly like row locks; rows are
 *   re-read after the lock is acquired (READ COMMITTED EvalPlanQual).
 * - Transactions roll back through an undo log (before-images), so a failed
 *   concurrent transaction never undoes another transaction's committed
 *   writes.
 * - Every statement is journaled inside its transaction so tests can assert
 *   transaction boundaries (begin/commit/rollback and statement grouping).
 *
 * The store mock is typed as `typeof import("../feature-store")`, so the
 * compiler verifies the fake stays in sync with the real storage layer.
 */

export type MemoryUser = {
  id: string;
  email: string;
  display_name: string;
  role: "contributor" | "moderator" | "admin";
  status: "pending_verification" | "active" | "suspended" | "deletion_pending" | "deleted";
  email_verified_at: Date | null;
  deleted_at: Date | null;
};

export type MemoryCategory = {
  key: string;
  name: string;
  icon: string;
  detail_schema: Record<string, string>;
  detail_schema_version: number;
  is_active: boolean;
  sort_order: number;
};

export type MemoryFeature = {
  id: string;
  category_key: string;
  owner_id: string;
  longitude: number;
  latitude: number;
  location_accuracy_m: number;
  current_revision_id: string | null;
  status: string;
  first_published_at: Date | null;
  freshness_expires_at: Date | null;
  needs_review_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type MemoryRevision = {
  id: string;
  feature_id: string;
  author_id: string;
  revision_no: number;
  payload: Record<string, unknown>;
  status: string;
  submitted_at: Date | null;
  reviewed_at: Date | null;
  reviewer_id: string | null;
  rejection_reason_code: string | null;
  moderation_notes: string | null;
  created_at: Date;
  updated_at: Date;
};

export type MemoryMedia = {
  id: string;
  owner_id: string;
  privacy_status: string;
  quarantine_object_key: string;
  processed_object_key: string | null;
  thumbnail_object_key: string | null;
  public_object_key: string | null;
  public_thumbnail_object_key: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type MemoryRevisionMedia = {
  revision_id: string;
  media_id: string;
  sort_order: number;
};

export type MemoryConfirmation = {
  id: string;
  feature_id: string;
  user_id: string;
  result: string;
  note: string | null;
  created_at: Date;
};

export type MemoryAudit = {
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
};

export type JournalEntry = {
  txId: number | null;
  event: "begin" | "commit" | "rollback" | "autocommit";
  statements: string[];
};

type Undo = () => void;

type TxContext = {
  id: number;
  undos: Undo[];
  statements: string[];
  heldLocks: Set<string>;
  releasers: Array<() => void>;
};

const DAY_MS = 24 * 3600 * 1000;

export class MemoryBackend {
  users = new Map<string, MemoryUser>();
  categories = new Map<string, MemoryCategory>();
  features = new Map<string, MemoryFeature>();
  revisions = new Map<string, MemoryRevision>();
  revisionMedia: MemoryRevisionMedia[] = [];
  media = new Map<string, MemoryMedia>();
  confirmations: MemoryConfirmation[] = [];
  auditLogs: MemoryAudit[] = [];

  journal: JournalEntry[] = [];
  events: string[] = [];

  readonly poolToken = {};

  private txSeq = 0;
  private lockChains = new Map<string, Promise<void>>();
  private txByClient = new WeakMap<object, TxContext>();

  reset(): void {
    this.users.clear();
    this.categories.clear();
    this.features.clear();
    this.revisions.clear();
    this.revisionMedia = [];
    this.media.clear();
    this.confirmations = [];
    this.auditLogs = [];
    this.journal = [];
    this.events = [];
    this.txSeq = 0;
    this.lockChains.clear();
    this.txByClient = new WeakMap();
  }

  // -------------------------------------------------------------------------
  // Transaction machinery
  // -------------------------------------------------------------------------

  txFor(db: unknown): TxContext | undefined {
    return typeof db === "object" && db !== null ? this.txByClient.get(db) : undefined;
  }

  record(db: unknown, op: string): void {
    const tx = this.txFor(db);
    if (tx) {
      tx.statements.push(op);
    } else {
      this.journal.push({ txId: null, event: "autocommit", statements: [op] });
    }
  }

  undoable(db: unknown, undo: Undo): void {
    this.txFor(db)?.undos.push(undo);
  }

  async acquireLockFor(db: unknown, key: string): Promise<void> {
    const tx = this.txFor(db);
    if (!tx || tx.heldLocks.has(key)) return;
    tx.heldLocks.add(key);
    const previous = this.lockChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lockChains.set(key, previous.then(() => current));
    tx.releasers.push(release);
    await previous;
  }

  async runInTransaction<T>(callback: (client: unknown) => Promise<T>): Promise<T> {
    const tx: TxContext = {
      id: ++this.txSeq,
      undos: [],
      statements: [],
      heldLocks: new Set(),
      releasers: []
    };
    const client = {};
    this.txByClient.set(client, tx);
    this.journal.push({ txId: tx.id, event: "begin", statements: [] });
    this.events.push(`tx${tx.id}:begin`);
    try {
      const result = await callback(client);
      this.journal.push({ txId: tx.id, event: "commit", statements: [...tx.statements] });
      this.events.push(`tx${tx.id}:commit`);
      return result;
    } catch (error) {
      for (const undo of tx.undos.splice(0).reverse()) undo();
      this.journal.push({ txId: tx.id, event: "rollback", statements: [...tx.statements] });
      this.events.push(`tx${tx.id}:rollback`);
      throw error;
    } finally {
      for (const release of tx.releasers.splice(0)) release();
    }
  }

  insertInto<V extends { id: string }>(db: unknown, map: Map<string, V>, row: V): void {
    map.set(row.id, row);
    this.undoable(db, () => map.delete(row.id));
  }

  updateRow<V extends { id: string }>(db: unknown, map: Map<string, V>, id: string, changes: Partial<V>): void {
    const current = map.get(id);
    if (!current) throw new Error(`memory backend: cannot update missing row ${id}`);
    const before = structuredClone(current);
    Object.assign(current, changes);
    this.undoable(db, () => map.set(id, before));
  }

  pushRow<V>(db: unknown, rows: V[], row: V): void {
    rows.push(row);
    this.undoable(db, () => {
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
    });
  }

  removeWhere<V>(db: unknown, rows: V[], predicate: (row: V) => boolean): V[] {
    const removed = rows.filter(predicate);
    for (const row of removed) rows.splice(rows.indexOf(row), 1);
    this.undoable(db, () => rows.push(...removed));
    return removed;
  }

  patchItem<V extends object>(db: unknown, item: V, changes: Partial<V>): void {
    const before = structuredClone(item);
    Object.assign(item, changes);
    this.undoable(db, () => Object.assign(item, before));
  }

  // -------------------------------------------------------------------------
  // Autocommit queries used outside the feature store (auth, health checks)
  // -------------------------------------------------------------------------

  autocommitQuery(text: string, values: unknown[] = []) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized === "SELECT 1") {
      return { rows: [{ "?column?": 1 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    }
    if (normalized.includes("FROM users WHERE id = $1")) {
      const user = this.users.get(String(values[0]));
      return {
        rows: user ? [user] : [],
        rowCount: user ? 1 : 0,
        command: "SELECT",
        oid: 0,
        fields: []
      };
    }
    throw new Error(`memory backend: unexpected autocommit query: ${normalized}`);
  }

  // -------------------------------------------------------------------------
  // Seed helpers
  // -------------------------------------------------------------------------

  seedUser(overrides: Partial<MemoryUser> = {}): MemoryUser {
    const user: MemoryUser = {
      id: randomUUID(),
      email: `${randomUUID()}@example.test`,
      display_name: "测试用户",
      role: "contributor",
      status: "active",
      email_verified_at: new Date(),
      deleted_at: null,
      ...overrides
    };
    this.users.set(user.id, user);
    return user;
  }

  seedCategory(key = "bench", overrides: Partial<MemoryCategory> = {}): MemoryCategory {
    const category: MemoryCategory = {
      key,
      name: key === "bench" ? "长椅" : key,
      icon: key,
      detail_schema: {},
      detail_schema_version: 1,
      is_active: true,
      sort_order: 10,
      ...overrides
    };
    this.categories.set(category.key, category);
    return category;
  }

  seedMedia(ownerId: string, overrides: Partial<MemoryMedia> = {}): MemoryMedia {
    const id = overrides.id ?? randomUUID();
    const media: MemoryMedia = {
      id,
      owner_id: ownerId,
      privacy_status: "ready",
      quarantine_object_key: `quarantine/${ownerId}/${id}.jpg`,
      processed_object_key: `processed/${ownerId}/${id}.webp`,
      thumbnail_object_key: `thumbs/${ownerId}/${id}.webp`,
      public_object_key: `public/${id}.webp`,
      public_thumbnail_object_key: `public/${id}-thumb.webp`,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
      ...overrides
    };
    this.media.set(media.id, media);
    return media;
  }

  seedPublishedFeature(
    ownerId: string,
    overrides: Partial<MemoryFeature> & { payload?: Record<string, unknown> } = {}
  ): { feature: MemoryFeature; revision: MemoryRevision } {
    const { payload, ...featureOverrides } = overrides;
    const now = new Date();
    const feature: MemoryFeature = {
      id: randomUUID(),
      category_key: "bench",
      owner_id: ownerId,
      longitude: 116.404,
      latitude: 39.915,
      location_accuracy_m: 5,
      current_revision_id: null,
      status: "published",
      first_published_at: now,
      freshness_expires_at: new Date(now.getTime() + 180 * DAY_MS),
      needs_review_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      ...featureOverrides
    };
    const revision: MemoryRevision = {
      id: randomUUID(),
      feature_id: feature.id,
      author_id: ownerId,
      revision_no: 1,
      payload: payload ?? defaultPayload(feature),
      status: "published",
      submitted_at: now,
      reviewed_at: now,
      reviewer_id: null,
      rejection_reason_code: null,
      moderation_notes: null,
      created_at: now,
      updated_at: now
    };
    feature.current_revision_id = revision.id;
    this.features.set(feature.id, feature);
    this.revisions.set(revision.id, revision);
    return { feature, revision };
  }

  latestRevisionOf(featureId: string): MemoryRevision | undefined {
    return [...this.revisions.values()]
      .filter((revision) => revision.feature_id === featureId)
      .sort((a, b) => b.revision_no - a.revision_no)[0];
  }
}

export function defaultPayload(feature: { category_key: string; longitude: number; latitude: number; location_accuracy_m: number }) {
  return {
    categoryKey: feature.category_key,
    title: "南门长椅",
    description: "有靠背和扶手的长椅，靠近南门入口。",
    longitude: feature.longitude,
    latitude: feature.latitude,
    locationAccuracyM: feature.location_accuracy_m,
    observedAt: "2026-09-20T08:00:00.000Z",
    condition: "good",
    tags: ["安静"],
    details: { seatCount: 3 },
    mediaIds: [] as string[]
  };
}

function mediaSummary(media: MemoryMedia) {
  return {
    id: media.id,
    privacy_status: media.privacy_status,
    public_object_key: media.public_object_key,
    public_thumbnail_object_key: media.public_thumbnail_object_key
  };
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

export function createStoreMock(backend: MemoryBackend): typeof FeatureStore {
  const mediaForRevision = (revisionId: string) =>
    backend.revisionMedia
      .filter((row) => row.revision_id === revisionId)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((row) => backend.media.get(row.media_id))
      .filter((item): item is MemoryMedia => Boolean(item && !item.deleted_at))
      .map(mediaSummary);

  return {
    async listActiveCategories(db) {
      backend.record(db, "listActiveCategories");
      return [...backend.categories.values()]
        .filter((category) => category.is_active)
        .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
        .map((category) => ({
          key: category.key,
          name: category.name,
          icon: category.icon,
          detail_schema: category.detail_schema,
          detail_schema_version: category.detail_schema_version,
          sort_order: category.sort_order
        }));
    },

    async searchPublishedFeatures(db, filter) {
      backend.record(db, "searchPublishedFeatures");
      const inBbox = (feature: MemoryFeature) => {
        const latOk = feature.latitude >= filter.minLat && feature.latitude <= filter.maxLat;
        const lonOk = filter.minLon > filter.maxLon
          ? feature.longitude >= filter.minLon || feature.longitude <= filter.maxLon
          : feature.longitude >= filter.minLon && feature.longitude <= filter.maxLon;
        return latOk && lonOk;
      };
      const rows: FeatureStore.FeatureSearchRow[] = [];
      const matches = [...backend.features.values()]
        .filter((feature) => feature.status === "published" && !feature.deleted_at)
        .filter(inBbox)
        .filter((feature) => filter.categories.length === 0 || filter.categories.includes(feature.category_key))
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
      for (const feature of matches) {
        // INNER JOIN on the current revision and category.
        const revision = feature.current_revision_id ? backend.revisions.get(feature.current_revision_id) : undefined;
        const category = backend.categories.get(feature.category_key);
        if (!revision || !category) continue;
        if (filter.condition && (revision.payload as { condition?: string }).condition !== filter.condition) continue;
        rows.push({
          id: feature.id,
          category_key: feature.category_key,
          status: feature.status,
          first_published_at: feature.first_published_at,
          freshness_expires_at: feature.freshness_expires_at,
          needs_review_at: feature.needs_review_at,
          updated_at: feature.updated_at,
          longitude: feature.longitude,
          latitude: feature.latitude,
          category_name: category.name,
          category_icon: category.icon,
          revision_id: revision.id,
          payload: structuredClone(revision.payload) as FeatureStore.FeaturePayloadRow,
          media: mediaForRevision(revision.id)
        });
        if (rows.length >= filter.limit) break;
      }
      return rows;
    },

    async findFeatureDetail(db, featureId) {
      backend.record(db, "findFeatureDetail");
      const feature = backend.features.get(featureId);
      if (!feature) return undefined;
      const category = backend.categories.get(feature.category_key);
      if (!category) return undefined;
      const current = feature.current_revision_id ? backend.revisions.get(feature.current_revision_id) : undefined;
      const latest = backend.latestRevisionOf(featureId);
      const effectiveRevisionId = feature.current_revision_id ?? latest?.id ?? null;
      const payload = current?.payload ?? latest?.payload ?? null;
      const mediaOrNull = (revisionId: string | null) => {
        if (!revisionId) return null;
        const rows = mediaForRevision(revisionId);
        return rows.length ? rows : null;
      };
      const media = mediaOrNull(effectiveRevisionId) ?? mediaOrNull(latest?.id ?? null) ?? [];
      return {
        id: feature.id,
        owner_id: feature.owner_id,
        category_key: feature.category_key,
        status: feature.status,
        location_accuracy_m: feature.location_accuracy_m,
        first_published_at: feature.first_published_at,
        freshness_expires_at: feature.freshness_expires_at,
        needs_review_at: feature.needs_review_at,
        created_at: feature.created_at,
        updated_at: feature.updated_at,
        deleted_at: feature.deleted_at,
        longitude: feature.longitude,
        latitude: feature.latitude,
        category_name: category.name,
        category_icon: category.icon,
        revision_id: effectiveRevisionId,
        payload: payload ? (structuredClone(payload) as FeatureStore.FeaturePayloadRow) : null,
        media
      };
    },

    async summarizeConfirmations(db, featureId) {
      backend.record(db, "summarizeConfirmations");
      const cutoff = Date.now() - 180 * DAY_MS;
      const counts = new Map<string, number>();
      for (const row of backend.confirmations) {
        if (row.feature_id !== featureId || row.created_at.getTime() <= cutoff) continue;
        counts.set(row.result, (counts.get(row.result) ?? 0) + 1);
      }
      return [...counts.entries()].map(([result, count]) => ({ result, count }));
    },

    async summarizeConfirmationsWithLatest(db, featureId) {
      backend.record(db, "summarizeConfirmationsWithLatest");
      const cutoff = Date.now() - 180 * DAY_MS;
      const groups = new Map<string, { count: number; latest: Date }>();
      for (const row of backend.confirmations) {
        if (row.feature_id !== featureId || row.created_at.getTime() <= cutoff) continue;
        const group = groups.get(row.result) ?? { count: 0, latest: row.created_at };
        group.count += 1;
        if (row.created_at > group.latest) group.latest = row.created_at;
        groups.set(row.result, group);
      }
      return [...groups.entries()].map(([result, group]) => ({
        result,
        count: group.count,
        latest_at: group.latest
      }));
    },

    async listOwnedFeatures(db, ownerId) {
      backend.record(db, "listOwnedFeatures");
      return [...backend.features.values()]
        .filter((feature) => feature.owner_id === ownerId && !feature.deleted_at)
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .map((feature) => {
          const revision = backend.latestRevisionOf(feature.id);
          return {
            id: feature.id,
            category_key: feature.category_key,
            status: feature.status,
            created_at: feature.created_at,
            updated_at: feature.updated_at,
            revision_id: revision?.id ?? null,
            revision_no: revision?.revision_no ?? null,
            revision_status: revision?.status ?? null,
            payload: revision ? structuredClone(revision.payload) : null,
            rejection_reason_code: revision?.rejection_reason_code ?? null,
            moderation_notes: revision?.moderation_notes ?? null
          };
        });
    },

    async findFeatureOwner(db, featureId) {
      backend.record(db, "findFeatureOwner");
      const feature = backend.features.get(featureId);
      if (!feature || feature.deleted_at) return undefined;
      return { owner_id: feature.owner_id };
    },

    async listFeatureRevisions(db, featureId) {
      backend.record(db, "listFeatureRevisions");
      return [...backend.revisions.values()]
        .filter((revision) => revision.feature_id === featureId)
        .sort((a, b) => b.revision_no - a.revision_no)
        .map((revision) => ({
          id: revision.id,
          revision_no: revision.revision_no,
          status: revision.status,
          payload: structuredClone(revision.payload),
          submitted_at: revision.submitted_at,
          reviewed_at: revision.reviewed_at,
          rejection_reason_code: revision.rejection_reason_code,
          moderation_notes: revision.moderation_notes,
          created_at: revision.created_at,
          updated_at: revision.updated_at
        }));
    },

    async isActiveCategory(db, categoryKey) {
      backend.record(db, "isActiveCategory");
      return backend.categories.get(categoryKey)?.is_active === true;
    },

    async findOwnedMedia(db, ownerId, mediaIds) {
      backend.record(db, "findOwnedMedia");
      return mediaIds
        .map((id) => backend.media.get(id))
        .filter((item): item is MemoryMedia => Boolean(item && item.owner_id === ownerId && !item.deleted_at))
        .map((item) => ({ id: item.id, privacy_status: item.privacy_status }));
    },

    async replaceRevisionMedia(db, revisionId, mediaIds) {
      backend.record(db, "replaceRevisionMedia");
      backend.removeWhere(db, backend.revisionMedia, (row) => row.revision_id === revisionId);
      mediaIds.forEach((mediaId, index) => {
        backend.pushRow(db, backend.revisionMedia, { revision_id: revisionId, media_id: mediaId, sort_order: index });
      });
    },

    async insertFeature(db, input) {
      backend.record(db, "insertFeature");
      const now = new Date();
      const feature: MemoryFeature = {
        id: randomUUID(),
        category_key: input.categoryKey,
        owner_id: input.ownerId,
        longitude: input.longitude,
        latitude: input.latitude,
        location_accuracy_m: input.locationAccuracyM,
        current_revision_id: null,
        status: "draft",
        first_published_at: null,
        freshness_expires_at: null,
        needs_review_at: null,
        created_at: now,
        updated_at: now,
        deleted_at: null
      };
      backend.insertInto(db, backend.features, feature);
      return feature.id;
    },

    async insertRevision(db, input) {
      backend.record(db, "insertRevision");
      const duplicated = [...backend.revisions.values()].some(
        (revision) => revision.feature_id === input.featureId && revision.revision_no === input.revisionNo
      );
      if (duplicated) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      }
      const now = new Date();
      const revision: MemoryRevision = {
        id: randomUUID(),
        feature_id: input.featureId,
        author_id: input.authorId,
        revision_no: input.revisionNo,
        payload: JSON.parse(input.payloadJson) as Record<string, unknown>,
        status: "draft",
        submitted_at: null,
        reviewed_at: null,
        reviewer_id: null,
        rejection_reason_code: null,
        moderation_notes: null,
        created_at: now,
        updated_at: now
      };
      backend.insertInto(db, backend.revisions, revision);
      return revision.id;
    },

    async lockFeature(db, featureId) {
      backend.record(db, "lockFeature");
      const candidate = backend.features.get(featureId);
      if (!candidate || candidate.deleted_at) return undefined;
      await backend.acquireLockFor(db, `feature:${featureId}`);
      // Re-check after the lock wait, like READ COMMITTED EvalPlanQual.
      const row = backend.features.get(featureId);
      if (!row || row.deleted_at) return undefined;
      return {
        owner_id: row.owner_id,
        status: row.status,
        current_revision_id: row.current_revision_id
      };
    },

    async lockLatestRevision(db, featureId) {
      backend.record(db, "lockLatestRevision");
      const candidate = backend.latestRevisionOf(featureId);
      if (!candidate) return undefined;
      await backend.acquireLockFor(db, `revision:${candidate.id}`);
      const row = backend.revisions.get(candidate.id);
      if (!row) return undefined;
      return { id: row.id, status: row.status, payload: structuredClone(row.payload) };
    },

    async updateRevisionAsDraft(db, revisionId, payloadJson) {
      backend.record(db, "updateRevisionAsDraft");
      backend.updateRow(db, backend.revisions, revisionId, {
        payload: JSON.parse(payloadJson) as Record<string, unknown>,
        status: "draft",
        rejection_reason_code: null,
        moderation_notes: null,
        updated_at: new Date()
      });
    },

    async updateFeatureDraft(db, input) {
      backend.record(db, "updateFeatureDraft");
      backend.updateRow(db, backend.features, input.id, {
        category_key: input.categoryKey,
        longitude: input.longitude,
        latitude: input.latitude,
        location_accuracy_m: input.locationAccuracyM,
        status: "draft",
        updated_at: new Date()
      });
    },

    async hasPendingRevision(db, featureId) {
      backend.record(db, "hasPendingRevision");
      return [...backend.revisions.values()].some(
        (revision) => revision.feature_id === featureId && revision.status === "pending"
      );
    },

    async nextRevisionNumber(db, featureId) {
      backend.record(db, "nextRevisionNumber");
      const numbers = [...backend.revisions.values()]
        .filter((revision) => revision.feature_id === featureId)
        .map((revision) => revision.revision_no);
      return (numbers.length ? Math.max(...numbers) : 0) + 1;
    },

    async lockRevisionById(db, revisionId, featureId) {
      backend.record(db, "lockRevisionById");
      const candidate = backend.revisions.get(revisionId);
      if (!candidate || candidate.feature_id !== featureId) return undefined;
      await backend.acquireLockFor(db, `revision:${revisionId}`);
      const row = backend.revisions.get(revisionId);
      if (!row || row.feature_id !== featureId) return undefined;
      return { id: row.id, status: row.status, payload: structuredClone(row.payload) };
    },

    async markRevisionPending(db, revisionId) {
      backend.record(db, "markRevisionPending");
      backend.updateRow(db, backend.revisions, revisionId, {
        status: "pending",
        submitted_at: new Date(),
        reviewed_at: null,
        reviewer_id: null,
        rejection_reason_code: null,
        updated_at: new Date()
      });
    },

    async markFeaturePending(db, featureId) {
      backend.record(db, "markFeaturePending");
      backend.updateRow(db, backend.features, featureId, {
        status: "pending",
        updated_at: new Date()
      });
    },

    async findFeatureMediaObjects(db, featureId) {
      backend.record(db, "findFeatureMediaObjects");
      const revisionIds = new Set(
        [...backend.revisions.values()]
          .filter((revision) => revision.feature_id === featureId)
          .map((revision) => revision.id)
      );
      const mediaIds = [
        ...new Set(
          backend.revisionMedia
            .filter((row) => revisionIds.has(row.revision_id))
            .map((row) => row.media_id)
        )
      ];
      return mediaIds
        .map((id) => backend.media.get(id))
        .filter((item): item is MemoryMedia => Boolean(item && !item.deleted_at))
        .map((item) => ({
          id: item.id,
          quarantine_object_key: item.quarantine_object_key,
          processed_object_key: item.processed_object_key,
          thumbnail_object_key: item.thumbnail_object_key,
          public_object_key: item.public_object_key,
          public_thumbnail_object_key: item.public_thumbnail_object_key
        }));
    },

    async softDeleteFeature(db, featureId) {
      backend.record(db, "softDeleteFeature");
      backend.updateRow(db, backend.features, featureId, {
        status: "deleted",
        deleted_at: new Date(),
        updated_at: new Date()
      });
    },

    async markMediaDeleted(db, mediaIds) {
      backend.record(db, "markMediaDeleted");
      for (const id of mediaIds) {
        const media = backend.media.get(id);
        if (!media) continue;
        backend.updateRow(db, backend.media, id, {
          privacy_status: "deleted",
          deleted_at: new Date(),
          updated_at: new Date()
        });
      }
    },

    async findFeatureStatus(db, featureId) {
      backend.record(db, "findFeatureStatus");
      const feature = backend.features.get(featureId);
      if (!feature || feature.deleted_at) return undefined;
      return { status: feature.status };
    },

    async upsertConfirmation(db, input) {
      backend.record(db, "upsertConfirmation");
      const existing = backend.confirmations.find(
        (row) => row.feature_id === input.featureId && row.user_id === input.userId
      );
      const cutoff = Date.now() - 90 * DAY_MS;
      if (existing) {
        if (existing.created_at.getTime() >= cutoff) return 0;
        backend.patchItem(db, existing, {
          result: input.result,
          note: input.note,
          created_at: new Date()
        });
        return 1;
      }
      backend.pushRow(db, backend.confirmations, {
        id: randomUUID(),
        feature_id: input.featureId,
        user_id: input.userId,
        result: input.result,
        note: input.note,
        created_at: new Date()
      });
      return 1;
    },

    async countRecentRiskyReporters(db, featureId) {
      backend.record(db, "countRecentRiskyReporters");
      const cutoff = Date.now() - 7 * DAY_MS;
      const reporters = new Set(
        backend.confirmations
          .filter(
            (row) =>
              row.feature_id === featureId &&
              (row.result === "changed" || row.result === "closed") &&
              row.created_at.getTime() > cutoff
          )
          .map((row) => row.user_id)
      );
      return reporters.size;
    },

    async markFeatureNeedsReview(db, featureId) {
      backend.record(db, "markFeatureNeedsReview");
      backend.updateRow(db, backend.features, featureId, {
        needs_review_at: new Date(),
        updated_at: new Date()
      });
    }
  };
}

export function createDbMock(backend: MemoryBackend) {
  return {
    pool: backend.poolToken,
    query: (text: string, values?: unknown[]) =>
      Promise.resolve(backend.autocommitQuery(text, values ?? [])),
    transaction: <T>(callback: (client: unknown) => Promise<T>) => backend.runInTransaction(callback),
    json: (value: unknown) => JSON.stringify(value)
  };
}

export function createAuditMock(backend: MemoryBackend) {
  return {
    recordAudit: (
      client: unknown,
      input: {
        actorId?: string | null;
        action: string;
        resourceType: string;
        resourceId?: string | null;
        metadata?: Record<string, unknown>;
      }
    ) => {
      backend.record(client, `audit:${input.action}`);
      backend.pushRow(client, backend.auditLogs, {
        actor_id: input.actorId ?? null,
        action: input.action,
        resource_type: input.resourceType,
        resource_id: input.resourceId ?? null,
        metadata: input.metadata ?? {}
      });
      return Promise.resolve();
    },
    queueOutbox: () => Promise.resolve(randomUUID()),
    createNotification: () => Promise.resolve(randomUUID())
  };
}

export function createStorageMock(backend: MemoryBackend) {
  return {
    internalS3: {},
    publicS3: {},
    publicMediaUrl: (key: string | null | undefined) =>
      key ? `https://media.example.test/${key}` : null,
    deleteObject: (bucket: string, key: string) => {
      backend.events.push(`s3:delete:${bucket}:${key}`);
      return Promise.resolve();
    },
    createPreviewUrl: () => Promise.resolve("https://media.example.test/preview"),
    createUploadUrl: () => Promise.resolve("https://media.example.test/upload"),
    getQuarantineMetadata: () => Promise.resolve({}),
    readQuarantineObject: () => Promise.resolve(Buffer.alloc(0)),
    publishMediaObject: () => Promise.resolve()
  };
}

export function createQueueMock() {
  return {
    mediaRedis: {},
    outboxRedis: {},
    mediaQueue: {},
    outboxQueue: {},
    enqueueMediaProcessing: () => Promise.resolve(),
    enqueueOutbox: () => Promise.resolve(),
    closeQueues: () => Promise.resolve()
  };
}

// Shared singletons: each test file gets its own module registry (and thus
// its own backend), while the module mocks and the tests within one file
// share this instance.
export const backend = new MemoryBackend();
export const storeMock = createStoreMock(backend);
export const dbMock = createDbMock(backend);
export const auditMock = createAuditMock(backend);
export const storageMock = createStorageMock(backend);
export const queueMock = createQueueMock();
