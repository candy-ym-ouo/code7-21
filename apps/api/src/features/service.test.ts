import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { createFeatureService } from "./service";
import type { FeatureService, FeatureServiceDeps } from "./service";
import type { FeaturePayloadInput } from "./serializers";
import type {
  AuditEntry,
  FeatureMediaCleanup,
  FeatureStore,
  InsertFeatureInput,
  InsertRevisionInput,
  PublishedSearchFilter,
  UpdateFeatureDraftInput,
  UpsertConfirmationInput
} from "./store";

/**
 * 服务层回归测试。FakeFeatureDb 是一个仅用于测试的内存存储层替身：
 * - 写方法在事务外调用会直接抛错，锁住“每个写用例一个事务”的边界；
 * - FOR UPDATE 方法按行排队，模拟并发提交下的锁顺序；
 * - 提交前写入只存在于 overlay 中，回滚即丢弃。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type FakeCategory = {
  key: string;
  name: string;
  icon: string;
  detail_schema: Record<string, unknown>;
  detail_schema_version: number;
  sort_order: number;
  is_active: boolean;
};

type FakeFeature = {
  id: string;
  category_key: string;
  owner_id: string;
  status: string;
  current_revision_id: string | null;
  longitude: number;
  latitude: number;
  location_accuracy_m: number;
  first_published_at: Date | null;
  freshness_expires_at: Date | null;
  needs_review_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

type FakeRevision = {
  id: string;
  feature_id: string;
  author_id: string;
  revision_no: number;
  payload: Record<string, any>;
  status: string;
  submitted_at: Date | null;
  reviewed_at: Date | null;
  reviewer_id: string | null;
  rejection_reason_code: string | null;
  moderation_notes: string | null;
  created_at: Date;
  updated_at: Date;
};

type FakeMedia = {
  id: string;
  owner_id: string;
  privacy_status: string;
  quarantine_object_key: string;
  processed_object_key: string | null;
  thumbnail_object_key: string | null;
  public_object_key: string | null;
  public_thumbnail_object_key: string | null;
  deleted_at: Date | null;
};

type FakeConfirmation = {
  id: string;
  feature_id: string;
  user_id: string;
  result: string;
  note: string | null;
  created_at: Date;
};

type FakeState = {
  categories: Map<string, FakeCategory>;
  features: Map<string, FakeFeature>;
  revisions: Map<string, FakeRevision>;
  revisionMedia: Map<string, Array<{ media_id: string; sort_order: number }>>;
  media: Map<string, FakeMedia>;
  confirmations: Map<string, FakeConfirmation>;
  auditLog: Array<AuditEntry & { id: string }>;
};

function emptyState(): FakeState {
  return {
    categories: new Map(),
    features: new Map(),
    revisions: new Map(),
    revisionMedia: new Map(),
    media: new Map(),
    confirmations: new Map(),
    auditLog: []
  };
}

class FakeFeatureDb {
  private state: FakeState = emptyState();
  private rowLocks = new Map<string, Promise<void>>();
  private nextId = 0;

  newId(prefix: string) {
    this.nextId += 1;
    return `${prefix}-${this.nextId}`;
  }

  // ---- 测试种子与断言辅助 ----

  seedCategory(key = "bench") {
    this.state.categories.set(key, {
      key,
      name: "长椅",
      icon: "bench",
      detail_schema: {},
      detail_schema_version: 1,
      sort_order: 10,
      is_active: true
    });
    return key;
  }

  seedFeature(overrides: Partial<FakeFeature> = {}) {
    const id = overrides.id ?? this.newId("feature");
    const now = new Date();
    this.state.features.set(id, {
      id,
      category_key: "bench",
      owner_id: "owner-1",
      status: "draft",
      current_revision_id: null,
      longitude: 116.404,
      latitude: 39.915,
      location_accuracy_m: 10,
      first_published_at: null,
      freshness_expires_at: null,
      needs_review_at: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      ...overrides
    });
    return id;
  }

  seedRevision(featureId: string, overrides: Partial<FakeRevision> = {}) {
    const id = overrides.id ?? this.newId("revision");
    const now = new Date();
    this.state.revisions.set(id, {
      id,
      feature_id: featureId,
      author_id: "owner-1",
      revision_no: 1,
      payload: {},
      status: "draft",
      submitted_at: null,
      reviewed_at: null,
      reviewer_id: null,
      rejection_reason_code: null,
      moderation_notes: null,
      created_at: now,
      updated_at: now,
      ...overrides
    });
    return id;
  }

  seedMedia(ownerId: string, overrides: Partial<FakeMedia> = {}) {
    const id = overrides.id ?? this.newId("media");
    this.state.media.set(id, {
      id,
      owner_id: ownerId,
      privacy_status: "ready",
      quarantine_object_key: `quarantine/${id}.jpg`,
      processed_object_key: `processed/${id}.webp`,
      thumbnail_object_key: `thumb/${id}.webp`,
      public_object_key: `public/${id}.webp`,
      public_thumbnail_object_key: `public-thumb/${id}.webp`,
      deleted_at: null,
      ...overrides
    });
    return id;
  }

  bindMedia(revisionId: string, mediaIds: string[]) {
    this.state.revisionMedia.set(revisionId, mediaIds.map((media_id, sort_order) => ({ media_id, sort_order })));
  }

  seedConfirmation(featureId: string, userId: string, result: string, ageDays: number) {
    const id = this.newId("confirmation");
    this.state.confirmations.set(`${featureId}:${userId}`, {
      id,
      feature_id: featureId,
      user_id: userId,
      result,
      note: null,
      created_at: new Date(Date.now() - ageDays * DAY_MS)
    });
    return id;
  }

  feature(id: string) {
    return this.state.features.get(id);
  }

  revision(id: string) {
    return this.state.revisions.get(id);
  }

  mediaAsset(id: string) {
    return this.state.media.get(id);
  }

  revisionMediaOf(revisionId: string) {
    return this.state.revisionMedia.get(revisionId) ?? [];
  }

  revisionsOf(featureId: string) {
    return [...this.state.revisions.values()].filter((revision) => revision.feature_id === featureId);
  }

  confirmationsOf(featureId: string) {
    return [...this.state.confirmations.values()].filter((confirmation) => confirmation.feature_id === featureId);
  }

  get auditLog() {
    return this.state.auditLog;
  }

  // ---- 事务与锁模拟 ----

  begin() {
    const committed = this.state;
    const overlays = new Map<keyof FakeState, FakeState[keyof FakeState]>();
    const releases: Array<() => void> = [];
    let open = true;

    const table = <K extends keyof FakeState>(name: K): FakeState[K] => {
      return (overlays.get(name) ?? committed[name]) as FakeState[K];
    };
    const tableForWrite = <K extends keyof FakeState>(name: K): FakeState[K] => {
      if (!open) throw new Error(`write after transaction closed: ${name}`);
      let overlay = overlays.get(name);
      if (!overlay) {
        overlay = structuredClone(committed[name]);
        overlays.set(name, overlay);
      }
      return overlay as FakeState[K];
    };
    const lock = async (key: string) => {
      if (!open) throw new Error(`lock after transaction closed: ${key}`);
      const previous = this.rowLocks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.rowLocks.set(key, previous.then(() => current));
      await previous;
      releases.push(release);
    };

    const finish = (apply: boolean) => {
      open = false;
      if (apply) {
        for (const [name, overlay] of overlays) {
          (committed as Record<string, unknown>)[name] = overlay;
        }
      }
      for (const release of releases.splice(0)) release();
    };

    return {
      store: this.createStore(table, tableForWrite, lock),
      commit: () => finish(true),
      rollback: () => finish(false)
    };
  }

  readStore(): FeatureStore {
    return this.createStore(
      (name) => this.state[name],
      (name) => {
        throw new Error(`write outside transaction: ${name}`);
      },
      (key) => Promise.reject(new Error(`lock outside transaction: ${key}`))
    );
  }

  private createStore(
    table: <K extends keyof FakeState>(name: K) => FakeState[K],
    tableForWrite: <K extends keyof FakeState>(name: K) => FakeState[K],
    lock: (key: string) => Promise<void>
  ): FeatureStore {
    const mediaRowsForRevision = (revisionId: string) => {
      const bindings = table("revisionMedia").get(revisionId);
      if (!bindings || bindings.length === 0) return null;
      const rows = bindings
        .slice()
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((binding) => table("media").get(binding.media_id))
        .filter((item): item is FakeMedia => Boolean(item) && !item!.deleted_at)
        .map((item) => ({
          id: item.id,
          privacy_status: item.privacy_status,
          public_object_key: item.public_object_key,
          public_thumbnail_object_key: item.public_thumbnail_object_key
        }));
      return rows.length ? rows : null;
    };

    const revisionsOf = (featureId: string) =>
      [...table("revisions").values()]
        .filter((revision) => revision.feature_id === featureId)
        .sort((a, b) => b.revision_no - a.revision_no);

    return {
      // ---- 查询 ----

      listActiveCategories: async () =>
        [...table("categories").values()]
          .filter((category) => category.is_active)
          .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
          .map(({ is_active: _ignored, ...category }) => category),

      searchPublishedFeatures: async (filter: PublishedSearchFilter) => {
        const [minLon, minLat, maxLon, maxLat] = filter.bbox;
        const rows = [...table("features").values()]
          .filter((feature) => feature.status === "published" && !feature.deleted_at)
          .filter((feature) => {
            const inLon = minLon > maxLon
              ? feature.longitude >= minLon || feature.longitude <= maxLon
              : feature.longitude >= minLon && feature.longitude <= maxLon;
            return inLon && feature.latitude >= minLat && feature.latitude <= maxLat;
          })
          .filter((feature) => !filter.categories.length || filter.categories.includes(feature.category_key))
          .map((feature) => {
            const revision = feature.current_revision_id ? table("revisions").get(feature.current_revision_id) : undefined;
            if (!revision) return null;
            if (filter.condition && revision.payload.condition !== filter.condition) return null;
            const category = table("categories").get(feature.category_key)!;
            return {
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
              payload: revision.payload as { title: string; description: string; condition: string; details: unknown; tags: string[] },
              media: mediaRowsForRevision(revision.id) ?? []
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null)
          .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
          .slice(0, filter.limit);
        return rows;
      },

      findFeatureDetail: async (id: string) => {
        const feature = table("features").get(id);
        if (!feature) return undefined;
        const category = table("categories").get(feature.category_key)!;
        const revisions = revisionsOf(id);
        const latest = revisions[0];
        const current = feature.current_revision_id ? table("revisions").get(feature.current_revision_id) : undefined;
        const effectiveRevisionId = feature.current_revision_id ?? latest?.id ?? null;
        const currentMedia = effectiveRevisionId ? mediaRowsForRevision(effectiveRevisionId) : null;
        const latestMedia = latest ? mediaRowsForRevision(latest.id) : null;
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
          revision_id: effectiveRevisionId ?? "",
          payload: (current?.payload ?? latest?.payload ?? null) as Record<string, any>,
          media: currentMedia ?? latestMedia ?? []
        };
      },

      listConfirmationCounts: async (featureId: string) => confirmationCounts(table("confirmations"), featureId, false),

      listConfirmationSummary: async (featureId: string) => confirmationCounts(table("confirmations"), featureId, true),

      findFeatureOwner: async (featureId: string) => {
        const feature = table("features").get(featureId);
        return feature && !feature.deleted_at ? { owner_id: feature.owner_id } : undefined;
      },

      listFeatureRevisions: async (featureId: string) =>
        revisionsOf(featureId).map((revision) => ({
          id: revision.id,
          revision_no: revision.revision_no,
          status: revision.status,
          payload: revision.payload,
          submitted_at: revision.submitted_at,
          reviewed_at: revision.reviewed_at,
          rejection_reason_code: revision.rejection_reason_code,
          moderation_notes: revision.moderation_notes,
          created_at: revision.created_at,
          updated_at: revision.updated_at
        })),

      listMyFeatures: async (ownerId: string) =>
        [...table("features").values()]
          .filter((feature) => feature.owner_id === ownerId && !feature.deleted_at)
          .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
          .map((feature) => {
            const latest = revisionsOf(feature.id)[0];
            return {
              id: feature.id,
              category_key: feature.category_key,
              status: feature.status,
              created_at: feature.created_at,
              updated_at: feature.updated_at,
              revision_id: latest?.id ?? null,
              revision_no: latest?.revision_no ?? null,
              revision_status: latest?.status ?? null,
              payload: latest?.payload ?? null,
              rejection_reason_code: latest?.rejection_reason_code ?? null,
              moderation_notes: latest?.moderation_notes ?? null
            };
          }),

      // ---- 草稿 ----

      isCategoryActive: async (key: string) => table("categories").get(key)?.is_active === true,

      lockFeatureById: async (id: string) => {
        await lock(`feature:${id}`);
        const feature = table("features").get(id);
        if (!feature || feature.deleted_at) return undefined;
        return {
          owner_id: feature.owner_id,
          status: feature.status,
          current_revision_id: feature.current_revision_id
        };
      },

      insertFeatureDraft: async (input: InsertFeatureInput) => {
        const features = tableForWrite("features");
        const id = `feature-${features.size + 1}-${Math.random().toString(36).slice(2, 10)}`;
        const now = new Date();
        features.set(id, {
          id,
          category_key: input.categoryKey,
          owner_id: input.ownerId,
          status: "draft",
          current_revision_id: null,
          longitude: input.longitude,
          latitude: input.latitude,
          location_accuracy_m: input.locationAccuracyM,
          first_published_at: null,
          freshness_expires_at: null,
          needs_review_at: null,
          created_at: now,
          updated_at: now,
          deleted_at: null
        });
        return id;
      },

      lockLatestRevisionId: async (featureId: string) => {
        const latest = revisionsOf(featureId)[0];
        if (!latest) return undefined;
        await lock(`revision:${latest.id}`);
        return { id: latest.id };
      },

      updateRevisionToDraft: async (revisionId: string, payload: unknown) => {
        const revision = tableForWrite("revisions").get(revisionId)!;
        revision.payload = structuredClone(payload) as Record<string, any>;
        revision.status = "draft";
        revision.rejection_reason_code = null;
        revision.moderation_notes = null;
        revision.updated_at = new Date();
      },

      updateFeatureDraft: async (id: string, input: UpdateFeatureDraftInput) => {
        const feature = tableForWrite("features").get(id)!;
        feature.category_key = input.categoryKey;
        feature.longitude = input.longitude;
        feature.latitude = input.latitude;
        feature.location_accuracy_m = input.locationAccuracyM;
        feature.status = "draft";
        feature.updated_at = new Date();
      },

      // ---- 修订 ----

      lockRevisionById: async (revisionId: string, featureId: string) => {
        const revision = table("revisions").get(revisionId);
        if (!revision || revision.feature_id !== featureId) return undefined;
        await lock(`revision:${revisionId}`);
        return { id: revision.id, status: revision.status, payload: revision.payload };
      },

      lockLatestRevision: async (featureId: string) => {
        const latest = revisionsOf(featureId)[0];
        if (!latest) return undefined;
        await lock(`revision:${latest.id}`);
        return { id: latest.id, status: latest.status, payload: latest.payload };
      },

      hasPendingRevision: async (featureId: string) =>
        [...table("revisions").values()].some((revision) => revision.feature_id === featureId && revision.status === "pending"),

      nextRevisionNo: async (featureId: string) => {
        const numbers = [...table("revisions").values()]
          .filter((revision) => revision.feature_id === featureId)
          .map((revision) => revision.revision_no);
        return (numbers.length ? Math.max(...numbers) : 0) + 1;
      },

      insertRevision: async (input: InsertRevisionInput) => {
        const revisions = tableForWrite("revisions");
        const duplicated = [...revisions.values()].some(
          (revision) => revision.feature_id === input.featureId && revision.revision_no === input.revisionNo
        );
        if (duplicated) {
          throw new Error('duplicate key value violates unique constraint "feature_revisions_feature_id_revision_no_key"');
        }
        const id = `revision-${revisions.size + 1}-${Math.random().toString(36).slice(2, 10)}`;
        const now = new Date();
        revisions.set(id, {
          id,
          feature_id: input.featureId,
          author_id: input.authorId,
          revision_no: input.revisionNo,
          payload: structuredClone(input.payload) as Record<string, any>,
          status: "draft",
          submitted_at: null,
          reviewed_at: null,
          reviewer_id: null,
          rejection_reason_code: null,
          moderation_notes: null,
          created_at: now,
          updated_at: now
        });
        return id;
      },

      markRevisionSubmitted: async (revisionId: string) => {
        const revision = tableForWrite("revisions").get(revisionId)!;
        revision.status = "pending";
        revision.submitted_at = new Date();
        revision.reviewed_at = null;
        revision.reviewer_id = null;
        revision.rejection_reason_code = null;
        revision.updated_at = new Date();
      },

      markFeaturePending: async (featureId: string) => {
        const feature = tableForWrite("features").get(featureId)!;
        feature.status = "pending";
        feature.updated_at = new Date();
      },

      // ---- 媒体绑定 ----

      findOwnedMedia: async (ownerId: string, mediaIds: string[]) =>
        mediaIds
          .map((id) => table("media").get(id))
          .filter((item): item is FakeMedia => Boolean(item) && item!.owner_id === ownerId && !item!.deleted_at)
          .map((item) => ({ id: item.id, privacy_status: item.privacy_status })),

      replaceRevisionMedia: async (revisionId: string, mediaIds: string[]) => {
        tableForWrite("revisionMedia").set(
          revisionId,
          mediaIds.map((media_id, sort_order) => ({ media_id, sort_order }))
        );
      },

      listFeatureMediaObjects: async (featureId: string) => {
        const revisionIds = new Set(revisionsOf(featureId).map((revision) => revision.id));
        const seen = new Set<string>();
        const rows: FeatureMediaCleanup[] = [];
        for (const [revisionId, bindings] of table("revisionMedia")) {
          if (!revisionIds.has(revisionId)) continue;
          for (const binding of bindings) {
            if (seen.has(binding.media_id)) continue;
            seen.add(binding.media_id);
            const media = table("media").get(binding.media_id);
            if (!media || media.deleted_at) continue;
            rows.push({
              id: media.id,
              quarantine_object_key: media.quarantine_object_key,
              processed_object_key: media.processed_object_key,
              thumbnail_object_key: media.thumbnail_object_key,
              public_object_key: media.public_object_key,
              public_thumbnail_object_key: media.public_thumbnail_object_key
            });
          }
        }
        return rows;
      },

      markMediaDeleted: async (mediaIds: string[]) => {
        const media = tableForWrite("media");
        for (const id of mediaIds) {
          const item = media.get(id);
          if (item) {
            item.privacy_status = "deleted";
            item.deleted_at = new Date();
          }
        }
      },

      // ---- 删除 ----

      softDeleteFeature: async (featureId: string) => {
        const feature = tableForWrite("features").get(featureId)!;
        feature.status = "deleted";
        feature.deleted_at = new Date();
        feature.updated_at = new Date();
      },

      // ---- 时效确认 ----

      findFeatureStatus: async (featureId: string) => {
        const feature = table("features").get(featureId);
        return feature && !feature.deleted_at ? { status: feature.status } : undefined;
      },

      upsertConfirmation: async (input: UpsertConfirmationInput) => {
        // 同步完成，模拟 INSERT ... ON CONFLICT 的原子性
        const confirmations = tableForWrite("confirmations");
        const key = `${input.featureId}:${input.userId}`;
        const existing = confirmations.get(key);
        if (existing) {
          if (existing.created_at.getTime() >= Date.now() - 90 * DAY_MS) return 0;
          existing.result = input.result;
          existing.note = input.note;
          existing.created_at = new Date();
          return 1;
        }
        confirmations.set(key, {
          id: `confirmation-${confirmations.size + 1}`,
          feature_id: input.featureId,
          user_id: input.userId,
          result: input.result,
          note: input.note,
          created_at: new Date()
        });
        return 1;
      },

      countRecentRiskyConfirmations: async (featureId: string) => {
        const users = new Set<string>();
        for (const confirmation of table("confirmations").values()) {
          if (
            confirmation.feature_id === featureId &&
            (confirmation.result === "changed" || confirmation.result === "closed") &&
            confirmation.created_at.getTime() > Date.now() - 7 * DAY_MS
          ) {
            users.add(confirmation.user_id);
          }
        }
        return users.size;
      },

      flagFeatureNeedsReview: async (featureId: string) => {
        const feature = tableForWrite("features").get(featureId)!;
        feature.needs_review_at = new Date();
        feature.updated_at = new Date();
      },

      // ---- 审计 ----

      recordAudit: async (entry: AuditEntry) => {
        tableForWrite("auditLog").push({ ...entry, id: `audit-${table("auditLog").length + 1}` });
      }
    };
  }
}

function confirmationCounts(confirmations: Map<string, FakeConfirmation>, featureId: string, withLatest: boolean) {
  const groups = new Map<string, { count: number; latest: number }>();
  for (const confirmation of confirmations.values()) {
    if (confirmation.feature_id !== featureId) continue;
    if (confirmation.created_at.getTime() <= Date.now() - 180 * DAY_MS) continue;
    const group = groups.get(confirmation.result) ?? { count: 0, latest: 0 };
    group.count += 1;
    group.latest = Math.max(group.latest, confirmation.created_at.getTime());
    groups.set(confirmation.result, group);
  }
  return [...groups.entries()].map(([result, group]) =>
    withLatest
      ? { result, count: group.count, latest_at: new Date(group.latest) }
      : { result, count: group.count }
  ) as any;
}

function createTestService(db: FakeFeatureDb) {
  const removedObjects: FeatureMediaCleanup[][] = [];
  const deps: FeatureServiceDeps = {
    runInTransaction: async (fn) => {
      const tx = db.begin();
      try {
        const result = await fn(tx.store);
        tx.commit();
        return result;
      } catch (error) {
        tx.rollback();
        throw error;
      }
    },
    readStore: db.readStore(),
    mediaUrl: (key) => (key ? `https://media.test/${key}` : null),
    removeMediaObjects: async (items) => {
      removedObjects.push(items);
    }
  };
  const service: FeatureService = createFeatureService(deps);
  return { service, removedObjects };
}

function validInput(overrides: Partial<FeaturePayloadInput> = {}): FeaturePayloadInput {
  return {
    categoryKey: "bench",
    title: "南门长椅",
    description: "有靠背和遮雨棚的长椅",
    longitude: 116.404,
    latitude: 39.915,
    locationAccuracyM: 10,
    observedAt: new Date("2026-09-01T08:00:00.000Z"),
    condition: "good",
    tags: [],
    details: {},
    mediaIds: [],
    ...overrides
  };
}

describe("草稿用例", () => {
  it("在一个事务中创建草稿、首修订、媒体绑定和审计", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const mediaId = db.seedMedia("owner-1");
    const { service } = createTestService(db);

    const featureId = await service.createDraft("owner-1", validInput({ mediaIds: [mediaId] }));

    const feature = db.feature(featureId)!;
    expect(feature.status).toBe("draft");
    expect(feature.owner_id).toBe("owner-1");
    expect(feature.longitude).toBe(116.404);
    const revisions = db.revisionsOf(featureId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.revision_no).toBe(1);
    expect(revisions[0]!.status).toBe("draft");
    expect(revisions[0]!.payload.observedAt).toBe("2026-09-01T08:00:00.000Z");
    expect(revisions[0]!.payload.mediaIds).toEqual([mediaId]);
    expect(db.revisionMediaOf(revisions[0]!.id)).toEqual([{ media_id: mediaId, sort_order: 0 }]);
    expect(db.auditLog).toHaveLength(1);
    expect(db.auditLog[0]).toMatchObject({
      actorId: "owner-1",
      action: "feature.draft_created",
      resourceType: "feature",
      resourceId: featureId,
      metadata: { categoryKey: "bench" }
    });
  });

  it("未知分类返回 400 且不写入任何数据", async () => {
    const db = new FakeFeatureDb();
    const { service } = createTestService(db);

    const error = await service.createDraft("owner-1", validInput()).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(400);
    expect((error as AppError).code).toBe("VALIDATION_FAILED");
    expect((error as AppError).message).toBe("Unknown category");
    expect(db.auditLog).toHaveLength(0);
  });

  it("媒体不属于当前账号时返回 400", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const mediaId = db.seedMedia("someone-else");
    const { service } = createTestService(db);

    const error = await service.createDraft("owner-1", validInput({ mediaIds: [mediaId] })).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(400);
    expect((error as AppError).message).toBe("One or more media items do not belong to this account");
  });

  it("媒体未完成隐私处理时返回 409 MEDIA_NOT_READY", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const mediaId = db.seedMedia("owner-1", { privacy_status: "processing" });
    const { service } = createTestService(db);

    const error = await service.createDraft("owner-1", validInput({ mediaIds: [mediaId] })).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(409);
    expect((error as AppError).code).toBe("MEDIA_NOT_READY");
    expect((error as AppError).details).toEqual({ mediaStatus: "processing" });
  });

  it("更新草稿会重置修订状态并替换媒体绑定", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "rejected" });
    const revisionId = db.seedRevision(featureId, {
      status: "rejected",
      rejection_reason_code: "INACCURATE",
      moderation_notes: "位置不准"
    });
    const oldMedia = db.seedMedia("owner-1");
    const newMedia = db.seedMedia("owner-1");
    db.bindMedia(revisionId, [oldMedia]);
    const { service } = createTestService(db);

    await service.updateDraft("owner-1", featureId, validInput({ mediaIds: [newMedia], title: "更新后的长椅" }));

    const revision = db.revision(revisionId)!;
    expect(revision.status).toBe("draft");
    expect(revision.rejection_reason_code).toBeNull();
    expect(revision.moderation_notes).toBeNull();
    expect(revision.payload.title).toBe("更新后的长椅");
    expect(db.revisionMediaOf(revisionId)).toEqual([{ media_id: newMedia, sort_order: 0 }]);
    expect(db.feature(featureId)!.status).toBe("draft");
  });

  it("非所有者不能编辑草稿", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "draft" });
    db.seedRevision(featureId);
    const { service } = createTestService(db);

    const error = await service.updateDraft("intruder", featureId, validInput()).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(403);
    expect((error as AppError).code).toBe("FORBIDDEN");
  });

  it("已发布内容不能通过草稿端点编辑", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "published" });
    db.seedRevision(featureId, { status: "published" });
    const { service } = createTestService(db);

    const error = await service.updateDraft("owner-1", featureId, validInput()).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(409);
    expect((error as AppError).message).toBe("Only draft or rejected content can be edited at this endpoint");
  });
});

describe("修订与提交", () => {
  it("为已发布内容创建下一个编号的修订", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const publishedRevision = db.newId("revision");
    const featureId = db.seedFeature({ status: "published", current_revision_id: publishedRevision });
    db.seedRevision(featureId, { id: publishedRevision, revision_no: 1, status: "published" });
    const { service } = createTestService(db);

    const revisionId = await service.createRevision("owner-1", featureId, validInput());

    expect(db.revision(revisionId)!.revision_no).toBe(2);
    expect(db.revision(revisionId)!.status).toBe("draft");
  });

  it("已有待审核修订时返回 409", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "published" });
    db.seedRevision(featureId, { revision_no: 1, status: "published" });
    db.seedRevision(featureId, { revision_no: 2, status: "pending" });
    const { service } = createTestService(db);

    const error = await service.createRevision("owner-1", featureId, validInput()).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(409);
    expect((error as AppError).message).toBe("A revision is already waiting for moderation");
  });

  it("提交草稿修订并把首次投稿的地点置为 pending", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "draft" });
    const revisionId = db.seedRevision(featureId, { status: "draft", payload: { mediaIds: [] } });
    const { service } = createTestService(db);

    await service.submitRevision("owner-1", featureId);

    expect(db.revision(revisionId)!.status).toBe("pending");
    expect(db.revision(revisionId)!.submitted_at).toBeInstanceOf(Date);
    expect(db.feature(featureId)!.status).toBe("pending");
  });

  it("已发布地点提交新修订时不改动地点状态", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const publishedRevision = db.newId("revision");
    const featureId = db.seedFeature({ status: "published", current_revision_id: publishedRevision });
    db.seedRevision(featureId, { id: publishedRevision, revision_no: 1, status: "published" });
    const draftId = db.seedRevision(featureId, { revision_no: 2, status: "draft", payload: { mediaIds: [] } });
    const { service } = createTestService(db);

    await service.submitRevision("owner-1", featureId, draftId);

    expect(db.revision(draftId)!.status).toBe("pending");
    expect(db.feature(featureId)!.status).toBe("published");
  });

  it("被拒的修订可以重新提交", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "rejected" });
    const revisionId = db.seedRevision(featureId, {
      status: "rejected",
      rejection_reason_code: "INACCURATE",
      payload: { mediaIds: [] }
    });
    const { service } = createTestService(db);

    await service.submitRevision("owner-1", featureId, revisionId);

    const revision = db.revision(revisionId)!;
    expect(revision.status).toBe("pending");
    expect(revision.rejection_reason_code).toBeNull();
  });

  it("重复提交同一修订返回 409", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "pending" });
    db.seedRevision(featureId, { status: "pending" });
    const { service } = createTestService(db);

    const error = await service.submitRevision("owner-1", featureId).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(409);
    expect((error as AppError).message).toBe("Revision is not eligible for submission");
  });

  it("提交其他地点的修订返回 404", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "draft" });
    const otherFeatureId = db.seedFeature({ status: "draft" });
    const foreignRevision = db.seedRevision(otherFeatureId, { status: "draft" });
    const { service } = createTestService(db);

    const error = await service.submitRevision("owner-1", featureId, foreignRevision).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(404);
    expect((error as AppError).message).toBe("Revision not found");
  });

  it("并发提交同一地点只有一个成功", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "draft" });
    const revisionId = db.seedRevision(featureId, { status: "draft", payload: { mediaIds: [] } });
    const { service } = createTestService(db);

    const results = await Promise.allSettled([
      service.submitRevision("owner-1", featureId),
      service.submitRevision("owner-1", featureId)
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as AppError;
    expect(reason).toBeInstanceOf(AppError);
    expect(reason.statusCode).toBe(409);
    expect(reason.code).toBe("CONFLICT");
    expect(reason.message).toBe("Revision is not eligible for submission");
    expect(db.revision(revisionId)!.status).toBe("pending");
    expect(db.feature(featureId)!.status).toBe("pending");
  });

  it("并发创建修订分配到不同编号", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const publishedRevision = db.newId("revision");
    const featureId = db.seedFeature({ status: "published", current_revision_id: publishedRevision });
    db.seedRevision(featureId, { id: publishedRevision, revision_no: 1, status: "published" });
    const { service } = createTestService(db);

    const [first, second] = await Promise.all([
      service.createRevision("owner-1", featureId, validInput({ title: "修订甲" })),
      service.createRevision("owner-1", featureId, validInput({ title: "修订乙" }))
    ]);

    const numbers = [db.revision(first)!.revision_no, db.revision(second)!.revision_no].sort();
    expect(numbers).toEqual([2, 3]);
  });
});

describe("删除", () => {
  it("软删除地点与媒体，提交后再清理对象存储", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "published" });
    const revisionId = db.seedRevision(featureId, { status: "published" });
    const mediaId = db.seedMedia("owner-1");
    db.bindMedia(revisionId, [mediaId]);
    const { service, removedObjects } = createTestService(db);

    await service.deleteFeature({ id: "owner-1", role: "contributor" }, featureId);

    expect(db.feature(featureId)!.status).toBe("deleted");
    expect(db.feature(featureId)!.deleted_at).toBeInstanceOf(Date);
    expect(db.mediaAsset(mediaId)!.privacy_status).toBe("deleted");
    expect(db.auditLog[0]).toMatchObject({ action: "feature.deleted", metadata: { mediaCount: 1 } });
    expect(removedObjects).toHaveLength(1);
    expect(removedObjects[0]).toEqual([
      {
        id: mediaId,
        quarantine_object_key: `quarantine/${mediaId}.jpg`,
        processed_object_key: `processed/${mediaId}.webp`,
        thumbnail_object_key: `thumb/${mediaId}.webp`,
        public_object_key: `public/${mediaId}.webp`,
        public_thumbnail_object_key: `public-thumb/${mediaId}.webp`
      }
    ]);
  });

  it("对象存储清理发生在数据库提交之后", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "draft" });
    db.seedRevision(featureId);
    const statusesAtCleanup: string[] = [];
    const service = createFeatureService({
      runInTransaction: async (fn) => {
        const tx = db.begin();
        try {
          const result = await fn(tx.store);
          tx.commit();
          return result;
        } catch (error) {
          tx.rollback();
          throw error;
        }
      },
      readStore: db.readStore(),
      mediaUrl: () => null,
      removeMediaObjects: async () => {
        statusesAtCleanup.push(db.feature(featureId)!.status);
      }
    });

    await service.deleteFeature({ id: "owner-1", role: "contributor" }, featureId);
    expect(statusesAtCleanup).toEqual(["deleted"]);
  });

  it("无权删除时不触碰对象存储", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "draft" });
    db.seedRevision(featureId);
    const { service, removedObjects } = createTestService(db);

    const error = await service.deleteFeature({ id: "intruder", role: "contributor" }, featureId).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(403);
    expect(db.feature(featureId)!.status).toBe("draft");
    expect(removedObjects).toHaveLength(0);
  });

  it("审核员可以删除他人地点", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "published" });
    db.seedRevision(featureId);
    const { service } = createTestService(db);

    await service.deleteFeature({ id: "moderator-1", role: "moderator" }, featureId);
    expect(db.feature(featureId)!.status).toBe("deleted");
  });
});

describe("时效确认", () => {
  it("记录确认", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "published" });
    const { service } = createTestService(db);

    await service.recordConfirmation("user-1", featureId, { result: "still_accurate" });
    const confirmations = db.confirmationsOf(featureId);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ feature_id: featureId, user_id: "user-1", result: "still_accurate" });
  });

  it("90 天内重复确认返回 409", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "published" });
    db.seedConfirmation(featureId, "user-1", "still_accurate", 10);
    const { service } = createTestService(db);

    const error = await service.recordConfirmation("user-1", featureId, { result: "changed" }).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(409);
    expect((error as AppError).message).toBe("This feature was already confirmed within the last 90 days");
  });

  it("90 天后可以再次确认", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "published" });
    db.seedConfirmation(featureId, "user-1", "still_accurate", 100);
    const { service } = createTestService(db);

    await service.recordConfirmation("user-1", featureId, { result: "changed" });
    const confirmation = db.confirmationsOf(featureId)[0]!;
    expect(confirmation.result).toBe("changed");
  });

  it("7 天内 3 个不同用户报告变化后标记待复核", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "published" });
    db.seedConfirmation(featureId, "user-a", "changed", 1);
    db.seedConfirmation(featureId, "user-b", "closed", 2);
    const { service } = createTestService(db);

    await service.recordConfirmation("user-c", featureId, { result: "changed" });
    expect(db.feature(featureId)!.needs_review_at).toBeInstanceOf(Date);
  });

  it("不足 3 人报告时不标记待复核", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "published" });
    db.seedConfirmation(featureId, "user-a", "changed", 1);
    const { service } = createTestService(db);

    await service.recordConfirmation("user-b", featureId, { result: "changed" });
    expect(db.feature(featureId)!.needs_review_at).toBeNull();
  });

  it("非已发布地点不能确认", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "draft" });
    const { service } = createTestService(db);

    const error = await service.recordConfirmation("user-1", featureId, { result: "changed" }).catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(404);
    expect((error as AppError).message).toBe("Published feature not found");
  });
});

describe("查询映射", () => {
  it("地图查询结果保持旧版响应结构", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const revisionId = db.newId("revision");
    const featureId = db.seedFeature({ status: "published", current_revision_id: revisionId });
    const mediaId = db.seedMedia("owner-1");
    db.seedRevision(featureId, {
      id: revisionId,
      status: "published",
      payload: {
        title: "南门长椅",
        description: "有靠背和遮雨棚的长椅",
        condition: "good",
        details: { seatCount: 3 },
        tags: ["靠树"],
        mediaIds: [mediaId]
      }
    });
    db.bindMedia(revisionId, [mediaId]);
    const { service } = createTestService(db);

    const results = await service.searchPublished({
      bbox: [116.3, 39.8, 116.5, 40.0],
      categories: [],
      condition: undefined,
      limit: 250
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: featureId,
      categoryKey: "bench",
      categoryName: "长椅",
      categoryIcon: "bench",
      status: "published",
      firstPublishedAt: null,
      freshnessExpiresAt: null,
      needsReviewAt: null,
      updatedAt: expect.any(Date),
      longitude: 116.404,
      latitude: 39.915,
      title: "南门长椅",
      description: "有靠背和遮雨棚的长椅",
      condition: "good",
      details: { seatCount: 3 },
      tags: ["靠树"],
      media: [
        {
          id: mediaId,
          status: "ready",
          url: `https://media.test/public/${mediaId}.webp`,
          thumbnailUrl: `https://media.test/public-thumb/${mediaId}.webp`
        }
      ]
    });
  });

  it("详情响应保留 payload 展开、媒体序列化和确认汇总", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const revisionId = db.newId("revision");
    const featureId = db.seedFeature({ status: "published", current_revision_id: revisionId });
    const mediaId = db.seedMedia("owner-1");
    db.seedRevision(featureId, {
      id: revisionId,
      status: "published",
      payload: {
        categoryKey: "bench",
        title: "南门长椅",
        longitude: 116.5,
        latitude: 39.9,
        mediaIds: [mediaId],
        observedAt: "2026-09-01T08:00:00.000Z"
      }
    });
    db.bindMedia(revisionId, [mediaId]);
    db.seedConfirmation(featureId, "user-a", "still_accurate", 1);
    const { service } = createTestService(db);

    const detail = await service.getFeatureDetail(featureId, undefined);

    // payload 展开覆盖同名顶层字段是旧版行为，必须保留
    const detailRecord = detail as Record<string, unknown>;
    expect(detailRecord.longitude).toBe(116.5);
    expect(detailRecord.title).toBe("南门长椅");
    expect(detailRecord.mediaIds).toEqual([mediaId]);
    expect(detail.media).toEqual([
      {
        id: mediaId,
        status: "ready",
        url: `https://media.test/public/${mediaId}.webp`,
        thumbnailUrl: `https://media.test/public-thumb/${mediaId}.webp`
      }
    ]);
    expect(detail.confirmations).toEqual([{ result: "still_accurate", count: 1 }]);
  });

  it("匿名访客看不到未发布地点，所有者和审核员可以", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "draft" });
    db.seedRevision(featureId, { payload: { title: "草稿" } });
    const { service } = createTestService(db);

    const anonymous = await service.getFeatureDetail(featureId, undefined).catch((item: unknown) => item);
    expect((anonymous as AppError).statusCode).toBe(404);

    const stranger = await service
      .getFeatureDetail(featureId, { id: "user-2", role: "contributor" })
      .catch((item: unknown) => item);
    expect((stranger as AppError).statusCode).toBe(404);

    await expect(service.getFeatureDetail(featureId, { id: "owner-1", role: "contributor" })).resolves.toMatchObject({
      id: featureId
    });
    await expect(service.getFeatureDetail(featureId, { id: "mod-1", role: "moderator" })).resolves.toMatchObject({
      id: featureId
    });
  });

  it("已删除地点对任何人都是 404", async () => {
    const db = new FakeFeatureDb();
    db.seedCategory();
    const featureId = db.seedFeature({ status: "deleted", deleted_at: new Date() });
    db.seedRevision(featureId);
    const { service } = createTestService(db);

    const error = await service
      .getFeatureDetail(featureId, { id: "owner-1", role: "contributor" })
      .catch((item: unknown) => item);
    expect((error as AppError).statusCode).toBe(404);
  });
});

describe("事务边界", () => {
  it("事务外的写操作会被拒绝", async () => {
    const db = new FakeFeatureDb();
    const store = db.readStore();
    await expect(store.markFeaturePending("feature-1")).rejects.toThrow(/outside transaction/);
    await expect(store.softDeleteFeature("feature-1")).rejects.toThrow(/outside transaction/);
    await expect(
      store.recordAudit({ action: "feature.deleted", resourceType: "feature" })
    ).rejects.toThrow(/outside transaction/);
  });
});
