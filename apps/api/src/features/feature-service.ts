import type { FeaturePayload } from "@map/shared/contracts";
import { pool, transaction, type Queryable } from "../db";
import { AppError, conflict, forbidden, notFound } from "../errors";
import type { AuthUser } from "../auth";
import { deleteObject, publicMediaUrl } from "../storage";
import { config } from "../config";
import { recordAudit } from "../audit";
import * as store from "./feature-store";

/**
 * Service layer for map features: business rules, authorization and
 * transaction orchestration. HTTP-agnostic — routes parse requests and call
 * these functions; the response shapes returned here match the documented
 * API contract.
 */

export type FeatureSearchInput = {
  bbox: string;
  category?: string | undefined;
  condition?: string | undefined;
  limit: number;
};

export type ConfirmationInput = {
  result: "still_accurate" | "changed" | "closed";
  note?: string | undefined;
};

function serializeMedia(media: store.MediaAssetSummaryRow[] | null | undefined) {
  return (media ?? []).map((item) => ({
    id: item.id,
    status: item.privacy_status,
    url: publicMediaUrl(item.public_object_key),
    thumbnailUrl: publicMediaUrl(item.public_thumbnail_object_key)
  }));
}

function payloadWithDate(input: FeaturePayload) {
  return {
    ...input,
    observedAt: input.observedAt.toISOString()
  };
}

function bboxFromString(value: string): [number, number, number, number] {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
    throw new AppError(400, "VALIDATION_FAILED", "bbox must contain four numbers");
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
  if (minLon === maxLon || minLat >= maxLat) throw new AppError(400, "VALIDATION_FAILED", "Invalid bbox order");
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new AppError(400, "VALIDATION_FAILED", "bbox is outside valid longitude/latitude ranges");
  }
  const longitudeSpan = minLon > maxLon ? 360 - minLon + maxLon : maxLon - minLon;
  if (longitudeSpan > 5 || maxLat - minLat > 5) throw new AppError(400, "VALIDATION_FAILED", "bbox is too large");
  return [minLon, minLat, maxLon, maxLat];
}

async function assertMediaUsable(db: Queryable, ownerId: string, mediaIds: string[]) {
  if (mediaIds.length === 0) return;
  const rows = await store.findOwnedMedia(db, ownerId, mediaIds);
  if (rows.length !== mediaIds.length) {
    throw new AppError(400, "VALIDATION_FAILED", "One or more media items do not belong to this account");
  }
  const invalid = rows.find((row) => !["ready", "manual_review"].includes(row.privacy_status));
  if (invalid) {
    throw new AppError(409, "MEDIA_NOT_READY", "All media must finish privacy processing before submission", { mediaStatus: invalid.privacy_status });
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listCategories() {
  return store.listActiveCategories(pool);
}

export async function searchFeatures(input: FeatureSearchInput) {
  const [minLon, minLat, maxLon, maxLat] = bboxFromString(input.bbox);
  const categories = input.category?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  const rows = await store.searchPublishedFeatures(pool, {
    minLon,
    minLat,
    maxLon,
    maxLat,
    categories,
    condition: input.condition,
    limit: input.limit
  });

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
    media: serializeMedia(row.media)
  }));
}

export async function getFeatureDetail(featureId: string, user: AuthUser | undefined) {
  const row = await store.findFeatureDetail(pool, featureId);
  if (!row || row.deleted_at) throw notFound("Feature not found");
  const canInspectPrivate = Boolean(user && (user.id === row.owner_id || ["moderator", "admin"].includes(user.role)));
  if (row.status !== "published" && !canInspectPrivate) throw notFound("Feature not found");

  const confirmations = await store.summarizeConfirmations(pool, featureId);

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
    media: serializeMedia(row.media),
    confirmations: confirmations
  };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export async function createDraft(userId: string, input: FeaturePayload): Promise<string> {
  return transaction(async (client) => {
    if (!(await store.isActiveCategory(client, input.categoryKey))) {
      throw new AppError(400, "VALIDATION_FAILED", "Unknown category");
    }
    await assertMediaUsable(client, userId, input.mediaIds);

    const featureId = await store.insertFeature(client, {
      categoryKey: input.categoryKey,
      ownerId: userId,
      longitude: input.longitude,
      latitude: input.latitude,
      locationAccuracyM: input.locationAccuracyM
    });
    const revisionId = await store.insertRevision(client, {
      featureId,
      authorId: userId,
      revisionNo: 1,
      payloadJson: JSON.stringify(payloadWithDate(input))
    });
    await store.replaceRevisionMedia(client, revisionId, input.mediaIds);
    await recordAudit(client, {
      actorId: userId,
      action: "feature.draft_created",
      resourceType: "feature",
      resourceId: featureId,
      metadata: { categoryKey: input.categoryKey }
    });
    return featureId;
  });
}

export async function updateDraft(userId: string, featureId: string, input: FeaturePayload): Promise<void> {
  await transaction(async (client) => {
    const row = await store.lockFeature(client, featureId);
    if (!row) throw notFound("Feature not found");
    if (row.owner_id !== userId) throw forbidden();
    if (!["draft", "rejected", "changes_requested"].includes(row.status)) {
      throw conflict("Only draft or rejected content can be edited at this endpoint");
    }
    if (!(await store.isActiveCategory(client, input.categoryKey))) {
      throw new AppError(400, "VALIDATION_FAILED", "Unknown or inactive category");
    }
    await assertMediaUsable(client, userId, input.mediaIds);
    const revision = await store.lockLatestRevision(client, featureId);
    if (!revision) throw notFound("Revision not found");
    await store.updateRevisionAsDraft(client, revision.id, JSON.stringify(payloadWithDate(input)));
    await store.replaceRevisionMedia(client, revision.id, input.mediaIds);
    await store.updateFeatureDraft(client, {
      id: featureId,
      categoryKey: input.categoryKey,
      longitude: input.longitude,
      latitude: input.latitude,
      locationAccuracyM: input.locationAccuracyM
    });
  });
}

// ---------------------------------------------------------------------------
// Revisions and submission
// ---------------------------------------------------------------------------

export async function createRevision(userId: string, featureId: string, input: FeaturePayload): Promise<string> {
  return transaction(async (client) => {
    const row = await store.lockFeature(client, featureId);
    if (!row) throw notFound("Feature not found");
    if (row.owner_id !== userId) throw forbidden();
    if (row.status === "deleted") throw conflict("Deleted content cannot be revised");
    if (!(await store.isActiveCategory(client, input.categoryKey))) {
      throw new AppError(400, "VALIDATION_FAILED", "Unknown or inactive category");
    }
    if (await store.hasPendingRevision(client, featureId)) {
      throw conflict("A revision is already waiting for moderation");
    }
    await assertMediaUsable(client, userId, input.mediaIds);
    const revisionNo = await store.nextRevisionNumber(client, featureId);
    const revisionId = await store.insertRevision(client, {
      featureId,
      authorId: userId,
      revisionNo,
      payloadJson: JSON.stringify(payloadWithDate(input))
    });
    await store.replaceRevisionMedia(client, revisionId, input.mediaIds);
    return revisionId;
  });
}

export async function submitFeature(
  userId: string,
  featureId: string,
  revisionId?: string
): Promise<void> {
  await transaction(async (client) => {
    const featureRow = await store.lockFeature(client, featureId);
    if (!featureRow) throw notFound("Feature not found");
    if (featureRow.owner_id !== userId) throw forbidden();

    const revision = revisionId
      ? await store.lockRevisionById(client, revisionId, featureId)
      : await store.lockLatestRevision(client, featureId);
    if (!revision) throw notFound("Revision not found");
    if (!["draft", "rejected", "changes_requested"].includes(revision.status)) {
      throw conflict("Revision is not eligible for submission");
    }

    const payload = revision.payload as { mediaIds?: string[] };
    await assertMediaUsable(client, userId, payload.mediaIds ?? []);
    await store.markRevisionPending(client, revision.id);
    if (!featureRow.current_revision_id) {
      await store.markFeaturePending(client, featureId);
    }
  });
}

export async function listRevisions(user: AuthUser, featureId: string) {
  const feature = await store.findFeatureOwner(pool, featureId);
  if (!feature) throw notFound("Feature not found");
  if (feature.owner_id !== user.id && !["moderator", "admin"].includes(user.role)) {
    throw forbidden();
  }
  return store.listFeatureRevisions(pool, featureId);
}

export async function listMyFeatures(userId: string) {
  return store.listOwnedFeatures(pool, userId);
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

export async function deleteFeature(user: AuthUser, featureId: string): Promise<void> {
  const media = await transaction(async (client) => {
    const row = await store.lockFeature(client, featureId);
    if (!row) throw notFound("Feature not found");
    const canDelete = row.owner_id === user.id || ["moderator", "admin"].includes(user.role);
    if (!canDelete) throw forbidden();

    const mediaRows = await store.findFeatureMediaObjects(client, featureId);
    await store.softDeleteFeature(client, featureId);
    if (mediaRows.length) {
      await store.markMediaDeleted(client, mediaRows.map((item) => item.id));
    }
    await recordAudit(client, {
      actorId: user.id,
      action: "feature.deleted",
      resourceType: "feature",
      resourceId: featureId,
      metadata: { mediaCount: mediaRows.length }
    });
    return mediaRows;
  });

  // Object storage cleanup happens only after the database transaction commits.
  const removals = media.flatMap((item) => [
    deleteObject(config.S3_QUARANTINE_BUCKET, item.quarantine_object_key),
    item.processed_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.processed_object_key) : Promise.resolve(),
    item.thumbnail_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.thumbnail_object_key) : Promise.resolve(),
    item.public_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_object_key) : Promise.resolve(),
    item.public_thumbnail_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_thumbnail_object_key) : Promise.resolve()
  ]);
  await Promise.allSettled(removals);
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

export async function getConfirmations(featureId: string) {
  return store.summarizeConfirmationsWithLatest(pool, featureId);
}

export async function recordConfirmation(
  userId: string,
  featureId: string,
  input: ConfirmationInput
): Promise<void> {
  await transaction(async (client) => {
    const feature = await store.findFeatureStatus(client, featureId);
    if (feature?.status !== "published") throw notFound("Published feature not found");
    const rowCount = await store.upsertConfirmation(client, {
      featureId,
      userId,
      result: input.result,
      note: input.note ?? null
    });
    if (!rowCount) throw conflict("This feature was already confirmed within the last 90 days");

    if (input.result !== "still_accurate") {
      const riskyCount = await store.countRecentRiskyReporters(client, featureId);
      if (riskyCount >= 3) {
        await store.markFeatureNeedsReview(client, featureId);
      }
    }
  });
}
