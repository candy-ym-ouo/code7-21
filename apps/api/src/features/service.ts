import type { UserRole } from "@map/shared/contracts";
import { AppError, conflict, forbidden, notFound } from "../errors";
import { payloadWithDate, serializeMedia } from "./serializers";
import type { FeaturePayloadInput, MediaUrlBuilder } from "./serializers";
import type { FeatureMediaCleanup, FeatureStore, PublishedSearchFilter } from "./store";

/**
 * 服务层：地点查询、草稿、修订、媒体绑定和时效确认的用例编排。
 * 每个写用例在且仅在一个 runInTransaction 中完成，行锁顺序与
 * 重构前的路由实现保持一致（先锁 map_features，再锁 feature_revisions）。
 */

export type Actor = {
  id: string;
  role: UserRole;
};

export type FeatureServiceDeps = {
  runInTransaction: <T>(fn: (store: FeatureStore) => Promise<T>) => Promise<T>;
  readStore: FeatureStore;
  mediaUrl: MediaUrlBuilder;
  removeMediaObjects: (items: FeatureMediaCleanup[]) => Promise<void>;
};

const DRAFT_EDITABLE_STATUSES = ["draft", "rejected", "changes_requested"];
const SUBMITTABLE_STATUSES = ["draft", "rejected", "changes_requested"];
const MODERATOR_ROLES = ["moderator", "admin"];

async function assertMediaUsable(store: FeatureStore, ownerId: string, mediaIds: string[]) {
  if (mediaIds.length === 0) return;
  const rows = await store.findOwnedMedia(ownerId, mediaIds);
  if (rows.length !== mediaIds.length) {
    throw new AppError(400, "VALIDATION_FAILED", "One or more media items do not belong to this account");
  }
  const invalid = rows.find((row) => !["ready", "manual_review"].includes(row.privacy_status));
  if (invalid) {
    throw new AppError(409, "MEDIA_NOT_READY", "All media must finish privacy processing before submission", { mediaStatus: invalid.privacy_status });
  }
}

export function createFeatureService(deps: FeatureServiceDeps) {
  const { readStore, mediaUrl } = deps;

  // ---- 查询 ----

  async function listCategories() {
    return readStore.listActiveCategories();
  }

  async function searchPublished(filter: PublishedSearchFilter) {
    const rows = await readStore.searchPublishedFeatures(filter);
    return rows.map((row) => ({
      id: row.id,
      categoryKey: row.category_key,
      categoryName: row.category_name,
      categoryIcon: row.category_icon,
      status: row.status,
      firstPublishedAt: row.first_published_at,
      freshnessExpiresAt: row.freshness_expires_at,
      needsReviewAt: row.needs_review_at,
      updatedAt: row.updated_at,
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      title: row.payload.title,
      description: row.payload.description,
      condition: row.payload.condition,
      details: row.payload.details,
      tags: row.payload.tags,
      media: serializeMedia(row.media, mediaUrl)
    }));
  }

  async function getFeatureDetail(id: string, viewer: Actor | undefined) {
    const row = await readStore.findFeatureDetail(id);
    if (!row || row.deleted_at) throw notFound("Feature not found");
    const canInspectPrivate = viewer && (viewer.id === row.owner_id || MODERATOR_ROLES.includes(viewer.role));
    if (row.status !== "published" && !canInspectPrivate) throw notFound("Feature not found");

    const confirmations = await readStore.listConfirmationCounts(id);

    return {
      id: row.id,
      ownerId: row.owner_id,
      categoryKey: row.category_key,
      categoryName: row.category_name,
      categoryIcon: row.category_icon,
      status: row.status,
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      locationAccuracyM: row.location_accuracy_m,
      firstPublishedAt: row.first_published_at,
      freshnessExpiresAt: row.freshness_expires_at,
      needsReviewAt: row.needs_review_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...row.payload,
      media: serializeMedia(row.media, mediaUrl),
      confirmations
    };
  }

  async function listRevisions(actor: Actor, featureId: string) {
    const feature = await readStore.findFeatureOwner(featureId);
    if (!feature) throw notFound("Feature not found");
    if (feature.owner_id !== actor.id && !MODERATOR_ROLES.includes(actor.role)) throw forbidden();
    return readStore.listFeatureRevisions(featureId);
  }

  async function listMyFeatures(userId: string) {
    return readStore.listMyFeatures(userId);
  }

  async function getConfirmations(featureId: string) {
    return readStore.listConfirmationSummary(featureId);
  }

  // ---- 草稿 ----

  async function createDraft(userId: string, input: FeaturePayloadInput): Promise<string> {
    return deps.runInTransaction(async (store) => {
      if (!(await store.isCategoryActive(input.categoryKey))) {
        throw new AppError(400, "VALIDATION_FAILED", "Unknown category");
      }
      await assertMediaUsable(store, userId, input.mediaIds);

      const featureId = await store.insertFeatureDraft({
        categoryKey: input.categoryKey,
        ownerId: userId,
        longitude: input.longitude,
        latitude: input.latitude,
        locationAccuracyM: input.locationAccuracyM
      });
      const revisionId = await store.insertRevision({
        featureId,
        authorId: userId,
        revisionNo: 1,
        payload: payloadWithDate(input)
      });
      await store.replaceRevisionMedia(revisionId, input.mediaIds);
      await store.recordAudit({
        actorId: userId,
        action: "feature.draft_created",
        resourceType: "feature",
        resourceId: featureId,
        metadata: { categoryKey: input.categoryKey }
      });
      return featureId;
    });
  }

  async function updateDraft(userId: string, featureId: string, input: FeaturePayloadInput): Promise<void> {
    await deps.runInTransaction(async (store) => {
      const feature = await store.lockFeatureById(featureId);
      if (!feature) throw notFound("Feature not found");
      if (feature.owner_id !== userId) throw forbidden();
      if (!DRAFT_EDITABLE_STATUSES.includes(feature.status)) {
        throw conflict("Only draft or rejected content can be edited at this endpoint");
      }
      if (!(await store.isCategoryActive(input.categoryKey))) {
        throw new AppError(400, "VALIDATION_FAILED", "Unknown or inactive category");
      }
      await assertMediaUsable(store, userId, input.mediaIds);
      const revision = await store.lockLatestRevisionId(featureId);
      if (!revision) throw notFound("Revision not found");
      await store.updateRevisionToDraft(revision.id, payloadWithDate(input));
      await store.replaceRevisionMedia(revision.id, input.mediaIds);
      await store.updateFeatureDraft(featureId, {
        categoryKey: input.categoryKey,
        longitude: input.longitude,
        latitude: input.latitude,
        locationAccuracyM: input.locationAccuracyM
      });
    });
  }

  // ---- 修订 ----

  async function createRevision(userId: string, featureId: string, input: FeaturePayloadInput): Promise<string> {
    return deps.runInTransaction(async (store) => {
      const feature = await store.lockFeatureById(featureId);
      if (!feature) throw notFound("Feature not found");
      if (feature.owner_id !== userId) throw forbidden();
      if (feature.status === "deleted") throw conflict("Deleted content cannot be revised");
      if (!(await store.isCategoryActive(input.categoryKey))) {
        throw new AppError(400, "VALIDATION_FAILED", "Unknown or inactive category");
      }
      if (await store.hasPendingRevision(featureId)) {
        throw conflict("A revision is already waiting for moderation");
      }
      await assertMediaUsable(store, userId, input.mediaIds);
      const revisionNo = await store.nextRevisionNo(featureId);
      const revisionId = await store.insertRevision({
        featureId,
        authorId: userId,
        revisionNo,
        payload: payloadWithDate(input)
      });
      await store.replaceRevisionMedia(revisionId, input.mediaIds);
      return revisionId;
    });
  }

  async function submitRevision(userId: string, featureId: string, revisionId?: string): Promise<void> {
    await deps.runInTransaction(async (store) => {
      const feature = await store.lockFeatureById(featureId);
      if (!feature) throw notFound("Feature not found");
      if (feature.owner_id !== userId) throw forbidden();

      const revision = revisionId
        ? await store.lockRevisionById(revisionId, featureId)
        : await store.lockLatestRevision(featureId);
      if (!revision) throw notFound("Revision not found");
      if (!SUBMITTABLE_STATUSES.includes(revision.status)) {
        throw conflict("Revision is not eligible for submission");
      }

      const payload = revision.payload as { mediaIds?: string[] };
      await assertMediaUsable(store, userId, payload.mediaIds ?? []);
      await store.markRevisionSubmitted(revision.id);
      if (!feature.current_revision_id) {
        await store.markFeaturePending(featureId);
      }
    });
  }

  // ---- 删除（媒体对象在事务提交后清理） ----

  async function deleteFeature(actor: Actor, featureId: string): Promise<void> {
    const media = await deps.runInTransaction(async (store) => {
      const feature = await store.lockFeatureById(featureId);
      if (!feature) throw notFound("Feature not found");
      const canDelete = feature.owner_id === actor.id || MODERATOR_ROLES.includes(actor.role);
      if (!canDelete) throw forbidden();

      const mediaRows = await store.listFeatureMediaObjects(featureId);
      await store.softDeleteFeature(featureId);
      if (mediaRows.length) {
        await store.markMediaDeleted(mediaRows.map((item) => item.id));
      }
      await store.recordAudit({
        actorId: actor.id,
        action: "feature.deleted",
        resourceType: "feature",
        resourceId: featureId,
        metadata: { mediaCount: mediaRows.length }
      });
      return mediaRows;
    });

    await deps.removeMediaObjects(media);
  }

  // ---- 时效确认 ----

  async function recordConfirmation(
    userId: string,
    featureId: string,
    input: { result: "still_accurate" | "changed" | "closed"; note?: string | undefined }
  ): Promise<void> {
    await deps.runInTransaction(async (store) => {
      const feature = await store.findFeatureStatus(featureId);
      if (feature?.status !== "published") throw notFound("Published feature not found");
      const inserted = await store.upsertConfirmation({
        featureId,
        userId,
        result: input.result,
        note: input.note ?? null
      });
      if (!inserted) throw conflict("This feature was already confirmed within the last 90 days");

      if (input.result !== "still_accurate") {
        const risky = await store.countRecentRiskyConfirmations(featureId);
        if (risky >= 3) {
          await store.flagFeatureNeedsReview(featureId);
        }
      }
    });
  }

  return {
    listCategories,
    searchPublished,
    getFeatureDetail,
    listRevisions,
    listMyFeatures,
    getConfirmations,
    createDraft,
    updateDraft,
    createRevision,
    submitRevision,
    deleteFeature,
    recordConfirmation
  };
}

export type FeatureService = ReturnType<typeof createFeatureService>;
