import type { PoolClient } from "pg";
import { recordAudit as recordAuditQuery } from "../audit";
import type { MediaRow } from "./serializers";

/**
 * 存储层：地点（map_features）、修订（feature_revisions）、媒体绑定
 * （revision_media）和时效确认（feature_confirmations）的全部 SQL。
 * 函数只接受一个可查询句柄（连接池或事务客户端），不含业务规则；
 * 事务边界由服务层决定。
 */

export type Queryable = Pick<PoolClient, "query">;

export type CategoryRow = {
  key: string;
  name: string;
  icon: string;
  detail_schema: unknown;
  detail_schema_version: number;
  sort_order: number;
};

export type FeatureSearchRow = {
  id: string;
  category_key: string;
  status: string;
  first_published_at: Date | null;
  freshness_expires_at: Date | null;
  needs_review_at: Date | null;
  updated_at: Date;
  longitude: number;
  latitude: number;
  category_name: string;
  category_icon: string;
  revision_id: string;
  payload: {
    title: string;
    description: string;
    condition: string;
    details: unknown;
    tags: string[];
  };
  media: MediaRow[];
};

export type FeatureDetailRow = {
  id: string;
  owner_id: string;
  category_key: string;
  status: string;
  location_accuracy_m: number;
  first_published_at: Date | null;
  freshness_expires_at: Date | null;
  needs_review_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  longitude: number;
  latitude: number;
  category_name: string;
  category_icon: string;
  revision_id: string;
  payload: Record<string, any>;
  media: MediaRow[];
};

export type LockedFeatureRow = {
  owner_id: string;
  status: string;
  current_revision_id: string | null;
};

export type LockedRevisionRow = {
  id: string;
  status: string;
  payload: Record<string, any>;
};

export type RevisionRow = {
  id: string;
  revision_no: number;
  status: string;
  payload: unknown;
  submitted_at: Date | null;
  reviewed_at: Date | null;
  rejection_reason_code: string | null;
  moderation_notes: string | null;
  created_at: Date;
  updated_at: Date;
};

export type MyFeatureRow = {
  id: string;
  category_key: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  revision_id: string | null;
  revision_no: number | null;
  revision_status: string | null;
  payload: unknown;
  rejection_reason_code: string | null;
  moderation_notes: string | null;
};

export type MediaUsableRow = {
  id: string;
  privacy_status: string;
};

export type FeatureMediaCleanup = {
  id: string;
  quarantine_object_key: string;
  processed_object_key: string | null;
  thumbnail_object_key: string | null;
  public_object_key: string | null;
  public_thumbnail_object_key: string | null;
};

export type ConfirmationCountRow = {
  result: string;
  count: number;
};

export type ConfirmationSummaryRow = {
  result: string;
  count: number;
  latest_at: Date;
};

export type AuditEntry = {
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
};

export type PublishedSearchFilter = {
  bbox: [number, number, number, number];
  categories: string[];
  condition: string | undefined;
  limit: number;
};

export type InsertFeatureInput = {
  categoryKey: string;
  ownerId: string;
  longitude: number;
  latitude: number;
  locationAccuracyM: number;
};

export type UpdateFeatureDraftInput = {
  categoryKey: string;
  longitude: number;
  latitude: number;
  locationAccuracyM: number;
};

export type InsertRevisionInput = {
  featureId: string;
  authorId: string;
  revisionNo: number;
  payload: unknown;
};

export type UpsertConfirmationInput = {
  featureId: string;
  userId: string;
  result: "still_accurate" | "changed" | "closed";
  note: string | null;
};

export function createFeatureStore(db: Queryable) {
  return {
    // ---- 查询 ----

    async listActiveCategories(): Promise<CategoryRow[]> {
      const result = await db.query<CategoryRow>(
        `SELECT key, name, icon, detail_schema, detail_schema_version, sort_order
         FROM categories WHERE is_active = true ORDER BY sort_order, key`
      );
      return result.rows;
    },

    async searchPublishedFeatures(filter: PublishedSearchFilter): Promise<FeatureSearchRow[]> {
      const [minLon, minLat, maxLon, maxLat] = filter.bbox;
      const values: unknown[] = [minLon, minLat, maxLon, maxLat, filter.limit];
      const conditions = [
        "mf.status = 'published'",
        "mf.deleted_at IS NULL"
      ];
      if (minLon > maxLon) {
        conditions.push(`(
          ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope($1, $2, 180, $4), 4326)::geography)
          OR ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope(-180, $2, $3, $4), 4326)::geography)
        )`);
      } else {
        conditions.push("ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope($1, $2, $3, $4), 4326)::geography)");
      }

      if (filter.categories.length) {
        values.push(filter.categories);
        conditions.push(`mf.category_key = ANY($${values.length}::text[])`);
      }
      if (filter.condition) {
        values.push(filter.condition);
        conditions.push(`fr.payload->>'condition' = $${values.length}`);
      }

      const result = await db.query<FeatureSearchRow>(
        `SELECT
           mf.id,
           mf.category_key,
           mf.status,
           mf.first_published_at,
           mf.freshness_expires_at,
           mf.needs_review_at,
           mf.updated_at,
           ST_X(mf.geom::geometry) AS longitude,
           ST_Y(mf.geom::geometry) AS latitude,
           c.name AS category_name,
           c.icon AS category_icon,
           fr.id AS revision_id,
           fr.payload,
           COALESCE(
             jsonb_agg(DISTINCT jsonb_build_object(
               'id', ma.id,
               'privacy_status', ma.privacy_status,
               'public_object_key', ma.public_object_key,
               'public_thumbnail_object_key', ma.public_thumbnail_object_key
             )) FILTER (WHERE ma.id IS NOT NULL),
             '[]'::jsonb
           ) AS media
         FROM map_features mf
         JOIN categories c ON c.key = mf.category_key
         JOIN feature_revisions fr ON fr.id = mf.current_revision_id
         LEFT JOIN revision_media rm ON rm.revision_id = fr.id
         LEFT JOIN media_assets ma ON ma.id = rm.media_id AND ma.deleted_at IS NULL
         WHERE ${conditions.join(" AND ")}
         GROUP BY mf.id, c.name, c.icon, fr.id
         ORDER BY mf.updated_at DESC
         LIMIT $5`,
        values
      );
      return result.rows;
    },

    async findFeatureDetail(id: string): Promise<FeatureDetailRow | undefined> {
      const result = await db.query<FeatureDetailRow>(
        `SELECT
           mf.id, mf.owner_id, mf.category_key, mf.status, mf.location_accuracy_m,
           mf.first_published_at, mf.freshness_expires_at, mf.needs_review_at,
           mf.created_at, mf.updated_at, mf.deleted_at,
           ST_X(mf.geom::geometry) AS longitude,
           ST_Y(mf.geom::geometry) AS latitude,
           c.name AS category_name, c.icon AS category_icon,
           COALESCE(mf.current_revision_id, latest.id) AS revision_id,
           COALESCE(current_revision.payload, latest.payload) AS payload,
           COALESCE(current_media.media, latest_media.media, '[]'::jsonb) AS media
         FROM map_features mf
         JOIN categories c ON c.key = mf.category_key
         LEFT JOIN feature_revisions current_revision ON current_revision.id = mf.current_revision_id
         LEFT JOIN LATERAL (
           SELECT id, payload FROM feature_revisions WHERE feature_id = mf.id ORDER BY revision_no DESC LIMIT 1
         ) latest ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'id', ma.id,
             'privacy_status', ma.privacy_status,
             'public_object_key', ma.public_object_key,
             'public_thumbnail_object_key', ma.public_thumbnail_object_key
           ) ORDER BY rm.sort_order) AS media
           FROM revision_media rm
           JOIN media_assets ma ON ma.id = rm.media_id AND ma.deleted_at IS NULL
           WHERE rm.revision_id = COALESCE(mf.current_revision_id, latest.id)
         ) current_media ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'id', ma.id,
             'privacy_status', ma.privacy_status,
             'public_object_key', ma.public_object_key,
             'public_thumbnail_object_key', ma.public_thumbnail_object_key
           ) ORDER BY rm.sort_order) AS media
           FROM revision_media rm
           JOIN media_assets ma ON ma.id = rm.media_id AND ma.deleted_at IS NULL
           WHERE rm.revision_id = latest.id
         ) latest_media ON true
         WHERE mf.id = $1`,
        [id]
      );
      return result.rows[0];
    },

    async listConfirmationCounts(featureId: string): Promise<ConfirmationCountRow[]> {
      const result = await db.query<ConfirmationCountRow>(
        `SELECT result, count(*)::int AS count
         FROM feature_confirmations
         WHERE feature_id = $1 AND created_at > now() - interval '180 days'
         GROUP BY result`,
        [featureId]
      );
      return result.rows;
    },

    async listConfirmationSummary(featureId: string): Promise<ConfirmationSummaryRow[]> {
      const result = await db.query<ConfirmationSummaryRow>(
        `SELECT result, count(*)::int AS count, max(created_at) AS latest_at
         FROM feature_confirmations
         WHERE feature_id = $1 AND created_at > now() - interval '180 days'
         GROUP BY result`,
        [featureId]
      );
      return result.rows;
    },

    async findFeatureOwner(featureId: string): Promise<{ owner_id: string } | undefined> {
      const result = await db.query<{ owner_id: string }>(
        "SELECT owner_id FROM map_features WHERE id = $1 AND deleted_at IS NULL",
        [featureId]
      );
      return result.rows[0];
    },

    async listFeatureRevisions(featureId: string): Promise<RevisionRow[]> {
      const result = await db.query<RevisionRow>(
        `SELECT id, revision_no, status, payload, submitted_at, reviewed_at, rejection_reason_code, moderation_notes, created_at, updated_at
         FROM feature_revisions WHERE feature_id = $1 ORDER BY revision_no DESC`,
        [featureId]
      );
      return result.rows;
    },

    async listMyFeatures(ownerId: string): Promise<MyFeatureRow[]> {
      const result = await db.query<MyFeatureRow>(
        `SELECT mf.id, mf.category_key, mf.status, mf.created_at, mf.updated_at,
                fr.id AS revision_id, fr.revision_no, fr.status AS revision_status,
                fr.payload, fr.rejection_reason_code, fr.moderation_notes
         FROM map_features mf
         LEFT JOIN LATERAL (
           SELECT * FROM feature_revisions WHERE feature_id = mf.id ORDER BY revision_no DESC LIMIT 1
         ) fr ON true
         WHERE mf.owner_id = $1 AND mf.deleted_at IS NULL
         ORDER BY mf.updated_at DESC`,
        [ownerId]
      );
      return result.rows;
    },

    // ---- 草稿 ----

    async isCategoryActive(key: string): Promise<boolean> {
      const result = await db.query("SELECT 1 FROM categories WHERE key = $1 AND is_active = true", [key]);
      return (result.rowCount ?? 0) > 0;
    },

    async lockFeatureById(id: string): Promise<LockedFeatureRow | undefined> {
      const result = await db.query<LockedFeatureRow>(
        "SELECT owner_id, status, current_revision_id FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [id]
      );
      return result.rows[0];
    },

    async insertFeatureDraft(input: InsertFeatureInput): Promise<string> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO map_features(category_key, owner_id, geom, location_accuracy_m, status)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, 'draft')
         RETURNING id`,
        [input.categoryKey, input.ownerId, input.longitude, input.latitude, input.locationAccuracyM]
      );
      return result.rows[0]!.id;
    },

    async lockLatestRevisionId(featureId: string): Promise<{ id: string } | undefined> {
      const result = await db.query<{ id: string }>(
        "SELECT id FROM feature_revisions WHERE feature_id = $1 ORDER BY revision_no DESC LIMIT 1 FOR UPDATE",
        [featureId]
      );
      return result.rows[0];
    },

    async updateRevisionToDraft(revisionId: string, payload: unknown): Promise<void> {
      await db.query(
        `UPDATE feature_revisions
         SET payload = $2::jsonb, status = 'draft', rejection_reason_code = NULL, moderation_notes = NULL, updated_at = now()
         WHERE id = $1`,
        [revisionId, JSON.stringify(payload)]
      );
    },

    async updateFeatureDraft(id: string, input: UpdateFeatureDraftInput): Promise<void> {
      await db.query(
        `UPDATE map_features
         SET category_key = $2, geom = ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
             location_accuracy_m = $5, status = 'draft', updated_at = now()
         WHERE id = $1`,
        [id, input.categoryKey, input.longitude, input.latitude, input.locationAccuracyM]
      );
    },

    // ---- 修订 ----

    async lockRevisionById(revisionId: string, featureId: string): Promise<LockedRevisionRow | undefined> {
      const result = await db.query<LockedRevisionRow>(
        "SELECT id, status, payload FROM feature_revisions WHERE id = $1 AND feature_id = $2 FOR UPDATE",
        [revisionId, featureId]
      );
      return result.rows[0];
    },

    async lockLatestRevision(featureId: string): Promise<LockedRevisionRow | undefined> {
      const result = await db.query<LockedRevisionRow>(
        "SELECT id, status, payload FROM feature_revisions WHERE feature_id = $1 ORDER BY revision_no DESC LIMIT 1 FOR UPDATE",
        [featureId]
      );
      return result.rows[0];
    },

    async hasPendingRevision(featureId: string): Promise<boolean> {
      const result = await db.query(
        "SELECT 1 FROM feature_revisions WHERE feature_id = $1 AND status = 'pending' LIMIT 1",
        [featureId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async nextRevisionNo(featureId: string): Promise<number> {
      const result = await db.query<{ next: number }>(
        "SELECT COALESCE(MAX(revision_no), 0) + 1 AS next FROM feature_revisions WHERE feature_id = $1",
        [featureId]
      );
      return result.rows[0]!.next;
    },

    async insertRevision(input: InsertRevisionInput): Promise<string> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO feature_revisions(feature_id, author_id, revision_no, payload, status)
         VALUES ($1, $2, $3, $4::jsonb, 'draft') RETURNING id`,
        [input.featureId, input.authorId, input.revisionNo, JSON.stringify(input.payload)]
      );
      return result.rows[0]!.id;
    },

    async markRevisionSubmitted(revisionId: string): Promise<void> {
      await db.query(
        `UPDATE feature_revisions
         SET status = 'pending', submitted_at = now(), reviewed_at = NULL,
             reviewer_id = NULL, rejection_reason_code = NULL, updated_at = now()
         WHERE id = $1`,
        [revisionId]
      );
    },

    async markFeaturePending(featureId: string): Promise<void> {
      await db.query("UPDATE map_features SET status = 'pending', updated_at = now() WHERE id = $1", [featureId]);
    },

    // ---- 媒体绑定 ----

    async findOwnedMedia(ownerId: string, mediaIds: string[]): Promise<MediaUsableRow[]> {
      const result = await db.query<MediaUsableRow>(
        `SELECT id, privacy_status FROM media_assets
         WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND deleted_at IS NULL`,
        [mediaIds, ownerId]
      );
      return result.rows;
    },

    async replaceRevisionMedia(revisionId: string, mediaIds: string[]): Promise<void> {
      await db.query("DELETE FROM revision_media WHERE revision_id = $1", [revisionId]);
      for (const [index, mediaId] of mediaIds.entries()) {
        await db.query(
          "INSERT INTO revision_media(revision_id, media_id, sort_order) VALUES ($1, $2, $3)",
          [revisionId, mediaId, index]
        );
      }
    },

    async listFeatureMediaObjects(featureId: string): Promise<FeatureMediaCleanup[]> {
      const result = await db.query<FeatureMediaCleanup>(
        `SELECT DISTINCT ma.id, ma.quarantine_object_key, ma.processed_object_key,
                ma.thumbnail_object_key, ma.public_object_key, ma.public_thumbnail_object_key
         FROM revision_media rm
         JOIN feature_revisions fr ON fr.id = rm.revision_id
         JOIN media_assets ma ON ma.id = rm.media_id
         WHERE fr.feature_id = $1 AND ma.deleted_at IS NULL`,
        [featureId]
      );
      return result.rows;
    },

    async markMediaDeleted(mediaIds: string[]): Promise<void> {
      await db.query(
        `UPDATE media_assets SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [mediaIds]
      );
    },

    // ---- 删除 ----

    async softDeleteFeature(featureId: string): Promise<void> {
      await db.query(
        "UPDATE map_features SET status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1",
        [featureId]
      );
    },

    // ---- 时效确认 ----

    async findFeatureStatus(featureId: string): Promise<{ status: string } | undefined> {
      const result = await db.query<{ status: string }>(
        "SELECT status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
        [featureId]
      );
      return result.rows[0];
    },

    async upsertConfirmation(input: UpsertConfirmationInput): Promise<number> {
      const result = await db.query(
        `INSERT INTO feature_confirmations(feature_id, user_id, result, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (feature_id, user_id) DO UPDATE
           SET result = EXCLUDED.result, note = EXCLUDED.note, created_at = now()
           WHERE feature_confirmations.created_at < now() - interval '90 days'
         RETURNING id`,
        [input.featureId, input.userId, input.result, input.note]
      );
      return result.rowCount ?? 0;
    },

    async countRecentRiskyConfirmations(featureId: string): Promise<number> {
      const result = await db.query<{ count: number }>(
        `SELECT count(DISTINCT user_id)::int AS count
         FROM feature_confirmations
         WHERE feature_id = $1 AND result IN ('changed', 'closed')
           AND created_at > now() - interval '7 days'`,
        [featureId]
      );
      return result.rows[0]!.count;
    },

    async flagFeatureNeedsReview(featureId: string): Promise<void> {
      await db.query(
        "UPDATE map_features SET needs_review_at = now(), updated_at = now() WHERE id = $1",
        [featureId]
      );
    },

    // ---- 审计（与调用方同一事务） ----

    async recordAudit(entry: AuditEntry): Promise<void> {
      await recordAuditQuery(db, entry);
    }
  };
}

export type FeatureStore = ReturnType<typeof createFeatureStore>;
