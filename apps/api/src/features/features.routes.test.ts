import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", async () => (await import("./testing/memory-backend")).dbMock);
vi.mock("../queue", async () => (await import("./testing/memory-backend")).queueMock);
vi.mock("../audit", async () => (await import("./testing/memory-backend")).auditMock);
vi.mock("../storage", async () => (await import("./testing/memory-backend")).storageMock);
vi.mock("./feature-store", async () => (await import("./testing/memory-backend")).storeMock);

import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { signAccessToken, type AuthUser } from "../auth";
import { backend, type MemoryUser } from "./testing/memory-backend";

/**
 * Legacy-client contract regression: exercises the real HTTP surface
 * (routes, validation, auth, error serialization) against the refactored
 * service/storage layers with an in-memory backend. Every assertion mirrors
 * the behavior legacy clients depend on.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  backend.reset();
  backend.seedCategory("bench", { name: "长椅", icon: "bench", sort_order: 10 });
});

function authOf(user: MemoryUser): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    emailVerified: Boolean(user.email_verified_at)
  };
}

function bearer(user: MemoryUser) {
  return { authorization: `Bearer ${signAccessToken(authOf(user))}` };
}

function featurePayload(overrides: Record<string, unknown> = {}) {
  return {
    categoryKey: "bench",
    title: "南门长椅",
    description: "有靠背和扶手的长椅，靠近南门入口。",
    longitude: 116.404,
    latitude: 39.915,
    locationAccuracyM: 5,
    observedAt: "2026-09-20T08:00:00.000Z",
    condition: "good",
    tags: ["安静"],
    details: { seatCount: 3 },
    mediaIds: [] as string[],
    ...overrides
  };
}

async function createDraft(user: MemoryUser, overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/features",
    headers: bearer(user),
    payload: featurePayload(overrides)
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; status: string };
}

describe("health and meta endpoints", () => {
  it("reports readiness", async () => {
    const response = await app.inject({ url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("lists active categories with the legacy row shape", async () => {
    backend.seedCategory("drinking_water", { name: "饮水处", icon: "water", sort_order: 20 });
    const response = await app.inject({ url: "/api/v1/categories" });
    expect(response.statusCode).toBe(200);
    const rows = response.json();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: "bench",
      name: "长椅",
      icon: "bench",
      detail_schema_version: 1,
      sort_order: 10
    });
    expect(rows[0]).toHaveProperty("detail_schema");
    expect(rows[1].key).toBe("drinking_water");
  });

  it("serializes unknown routes as problem details", async () => {
    const response = await app.inject({ url: "/api/v1/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});

describe("GET /features map query contract", () => {
  it("rejects malformed bbox values with VALIDATION_FAILED", async () => {
    const cases = [
      "1,2,3", // not four numbers
      "0,0,0,1", // zero width
      "0,2,1,1", // minLat >= maxLat
      "0,0,6,1", // longitude span too large
      "0,0,1,6", // latitude span too large
      "200,0,201,1", // outside longitude range
      "a,b,c,d" // not numbers
    ];
    for (const bbox of cases) {
      const response = await app.inject({ url: `/api/v1/features?bbox=${bbox}` });
      expect(response.statusCode, `bbox=${bbox}`).toBe(400);
      expect(response.json().code).toBe("VALIDATION_FAILED");
    }
  });

  it("requires the bbox parameter", async () => {
    const response = await app.inject({ url: "/api/v1/features" });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });

  it("returns published features inside the bbox with the legacy camelCase shape", async () => {
    const owner = backend.seedUser();
    const inside = backend.seedPublishedFeature(owner.id, {
      longitude: 116.4,
      latitude: 39.9,
      updated_at: new Date("2026-09-01T00:00:00Z")
    });
    backend.seedPublishedFeature(owner.id, {
      longitude: 116.41,
      latitude: 39.91,
      updated_at: new Date("2026-09-02T00:00:00Z")
    });
    backend.seedPublishedFeature(owner.id, { longitude: 117.5, latitude: 39.9 }); // outside bbox
    const draftOwner = backend.seedUser();
    await createDraft(draftOwner, { longitude: 116.4, latitude: 39.9 }); // drafts stay hidden

    const response = await app.inject({ url: "/api/v1/features?bbox=116.30,39.80,116.50,40.00" });
    expect(response.statusCode).toBe(200);
    const rows = response.json();
    expect(rows).toHaveLength(2);
    // ordered by updated_at DESC
    expect(rows[0].updatedAt > rows[1].updatedAt).toBe(true);
    const item = rows[1];
    expect(item).toMatchObject({
      id: inside.feature.id,
      categoryKey: "bench",
      categoryName: "长椅",
      categoryIcon: "bench",
      status: "published",
      title: "南门长椅",
      condition: "good",
      tags: ["安静"],
      details: { seatCount: 3 }
    });
    expect(item.longitude).toBeCloseTo(116.4);
    expect(item.latitude).toBeCloseTo(39.9);
    // the list shape intentionally excludes owner and payload internals
    expect(item).not.toHaveProperty("ownerId");
    expect(item).not.toHaveProperty("mediaIds");
    expect(item).not.toHaveProperty("locationAccuracyM");
    expect(item.media).toEqual([]);
  });

  it("serializes bound media on map results", async () => {
    const owner = backend.seedUser();
    const { revision } = backend.seedPublishedFeature(owner.id);
    const media = backend.seedMedia(owner.id);
    backend.revisionMedia.push({ revision_id: revision.id, media_id: media.id, sort_order: 0 });

    const response = await app.inject({ url: "/api/v1/features?bbox=116.30,39.80,116.50,40.00" });
    const [item] = response.json();
    expect(item.media).toEqual([
      {
        id: media.id,
        status: "ready",
        url: `https://media.example.test/${media.public_object_key}`,
        thumbnailUrl: `https://media.example.test/${media.public_thumbnail_object_key}`
      }
    ]);
  });

  it("supports antimeridian-crossing bbox queries", async () => {
    const owner = backend.seedUser();
    backend.seedPublishedFeature(owner.id, { longitude: 179.5, latitude: 0 });
    backend.seedPublishedFeature(owner.id, { longitude: -179.5, latitude: 0 });
    backend.seedPublishedFeature(owner.id, { longitude: 0, latitude: 0 }); // outside

    const response = await app.inject({ url: "/api/v1/features?bbox=179,-1,-179,1" });
    expect(response.statusCode).toBe(200);
    const rows = response.json();
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { longitude: number }) => row.longitude).sort()).toEqual([-179.5, 179.5]);
  });

  it("filters by category and condition and honors the limit", async () => {
    const owner = backend.seedUser();
    backend.seedCategory("drinking_water", { name: "饮水处", icon: "water", sort_order: 20 });
    backend.seedPublishedFeature(owner.id, { category_key: "bench", updated_at: new Date("2026-09-01T00:00:00Z") });
    backend.seedPublishedFeature(owner.id, { category_key: "bench", updated_at: new Date("2026-09-02T00:00:00Z") });
    backend.seedPublishedFeature(owner.id, {
      category_key: "drinking_water",
      updated_at: new Date("2026-09-03T00:00:00Z"),
      payload: {
        categoryKey: "drinking_water",
        title: "直饮水点",
        description: "公园北门内的直饮水设施。",
        longitude: 116.404,
        latitude: 39.915,
        locationAccuracyM: 5,
        observedAt: "2026-09-20T08:00:00.000Z",
        condition: "poor",
        tags: [],
        details: {},
        mediaIds: []
      }
    });

    const benches = await app.inject({ url: "/api/v1/features?bbox=116.30,39.80,116.50,40.00&category=bench" });
    expect(benches.json()).toHaveLength(2);

    const both = await app.inject({ url: "/api/v1/features?bbox=116.30,39.80,116.50,40.00&category=bench,drinking_water" });
    expect(both.json()).toHaveLength(3);

    const poor = await app.inject({ url: "/api/v1/features?bbox=116.30,39.80,116.50,40.00&condition=poor" });
    expect(poor.json()).toHaveLength(1);
    expect(poor.json()[0].condition).toBe("poor");

    const limited = await app.inject({ url: "/api/v1/features?bbox=116.30,39.80,116.50,40.00&limit=1" });
    expect(limited.json()).toHaveLength(1);
    expect(limited.json()[0].categoryKey).toBe("drinking_water");
  });
});

describe("GET /features/:id visibility contract", () => {
  it("hides non-published content from anonymous clients", async () => {
    const owner = backend.seedUser();
    const draft = await createDraft(owner);

    const anonymous = await app.inject({ url: `/api/v1/features/${draft.id}` });
    expect(anonymous.statusCode).toBe(404);
    expect(anonymous.json().code).toBe("NOT_FOUND");

    const stranger = backend.seedUser();
    const other = await app.inject({ url: `/api/v1/features/${draft.id}`, headers: bearer(stranger) });
    expect(other.statusCode).toBe(404);
  });

  it("lets the owner and moderators inspect private states", async () => {
    const owner = backend.seedUser();
    const draft = await createDraft(owner);

    const asOwner = await app.inject({ url: `/api/v1/features/${draft.id}`, headers: bearer(owner) });
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.json().status).toBe("draft");

    const moderator = backend.seedUser({ role: "moderator" });
    const asModerator = await app.inject({ url: `/api/v1/features/${draft.id}`, headers: bearer(moderator) });
    expect(asModerator.statusCode).toBe(200);
  });

  it("returns the full detail shape including payload fields and confirmations", async () => {
    const owner = backend.seedUser();
    const media = backend.seedMedia(owner.id);
    const created = await createDraft(owner, { mediaIds: [media.id] });

    const response = await app.inject({ url: `/api/v1/features/${created.id}`, headers: bearer(owner) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: created.id,
      ownerId: owner.id,
      categoryKey: "bench",
      categoryName: "长椅",
      categoryIcon: "bench",
      status: "draft",
      locationAccuracyM: 5,
      title: "南门长椅",
      description: "有靠背和扶手的长椅，靠近南门入口。",
      condition: "good",
      observedAt: "2026-09-20T08:00:00.000Z",
      tags: ["安静"],
      details: { seatCount: 3 },
      mediaIds: [media.id]
    });
    expect(body.longitude).toBeCloseTo(116.404);
    expect(body.latitude).toBeCloseTo(39.915);
    expect(body.media).toEqual([
      {
        id: media.id,
        status: "ready",
        url: `https://media.example.test/${media.public_object_key}`,
        thumbnailUrl: `https://media.example.test/${media.public_thumbnail_object_key}`
      }
    ]);
    expect(body.confirmations).toEqual([]);
    expect(body).toHaveProperty("createdAt");
    expect(body).toHaveProperty("updatedAt");
    expect(body).toHaveProperty("firstPublishedAt");
    expect(body).toHaveProperty("freshnessExpiresAt");
    expect(body).toHaveProperty("needsReviewAt");
  });

  it("rejects non-uuid identifiers with VALIDATION_FAILED", async () => {
    const response = await app.inject({ url: "/api/v1/features/not-a-uuid" });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });
});

describe("contribution flow contract", () => {
  it("requires authentication and a verified email to create drafts", async () => {
    const anonymous = await app.inject({ method: "POST", url: "/api/v1/features", payload: featurePayload() });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({
      type: "about:blank",
      status: 401,
      code: "AUTH_REQUIRED"
    });
    expect(anonymous.json()).toHaveProperty("requestId");
    expect(anonymous.json()).toHaveProperty("detail");

    const unverified = backend.seedUser({ email_verified_at: null, status: "pending_verification" });
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/features",
      headers: bearer(unverified),
      payload: featurePayload()
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("validates the request body against the shared schema", async () => {
    const user = backend.seedUser();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/features",
      headers: bearer(user),
      payload: featurePayload({ title: "ab" })
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("creates a draft and returns 201 with the legacy body", async () => {
    const user = backend.seedUser();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/features",
      headers: bearer(user),
      payload: featurePayload()
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["id", "status"]);
    expect(body.status).toBe("draft");
    expect(backend.features.get(body.id)?.owner_id).toBe(user.id);
    expect(backend.auditLogs.some((row) => row.action === "feature.draft_created" && row.resource_id === body.id)).toBe(true);
  });

  it("rejects unknown categories", async () => {
    const user = backend.seedUser();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/features",
      headers: bearer(user),
      payload: featurePayload({ categoryKey: "drinking_water" })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });

  it("enforces media ownership and privacy processing state", async () => {
    const owner = backend.seedUser();
    const stranger = backend.seedUser();
    const foreign = backend.seedMedia(stranger.id);

    const notOwned = await app.inject({
      method: "POST",
      url: "/api/v1/features",
      headers: bearer(owner),
      payload: featurePayload({ mediaIds: [foreign.id] })
    });
    expect(notOwned.statusCode).toBe(400);
    expect(notOwned.json().detail).toBe("One or more media items do not belong to this account");

    const processing = backend.seedMedia(owner.id, { privacy_status: "scanning" });
    const notReady = await app.inject({
      method: "POST",
      url: "/api/v1/features",
      headers: bearer(owner),
      payload: featurePayload({ mediaIds: [processing.id] })
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({ code: "MEDIA_NOT_READY", details: { mediaStatus: "scanning" } });

    const manualReview = backend.seedMedia(owner.id, { privacy_status: "manual_review" });
    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/features",
      headers: bearer(owner),
      payload: featurePayload({ mediaIds: [manualReview.id] })
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("updates drafts and rejects edits on published content", async () => {
    const owner = backend.seedUser();
    const draft = await createDraft(owner);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/features/${draft.id}/draft`,
      headers: bearer(owner),
      payload: featurePayload({ title: "改名后的长椅" })
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ status: "draft" });
    expect(backend.latestRevisionOf(draft.id)?.payload?.title).toBe("改名后的长椅");

    const stranger = backend.seedUser();
    const forbidden = await app.inject({
      method: "PATCH",
      url: `/api/v1/features/${draft.id}/draft`,
      headers: bearer(stranger),
      payload: featurePayload()
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe("FORBIDDEN");

    const published = backend.seedPublishedFeature(owner.id);
    const conflicted = await app.inject({
      method: "PATCH",
      url: `/api/v1/features/${published.feature.id}/draft`,
      headers: bearer(owner),
      payload: featurePayload()
    });
    expect(conflicted.statusCode).toBe(409);
    expect(conflicted.json().code).toBe("CONFLICT");

    const missing = await app.inject({
      method: "PATCH",
      url: `/api/v1/features/${crypto.randomUUID()}/draft`,
      headers: bearer(owner),
      payload: featurePayload()
    });
    expect(missing.statusCode).toBe(404);
  });

  it("submits drafts for moderation exactly once", async () => {
    const owner = backend.seedUser();
    const draft = await createDraft(owner);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/features/${draft.id}/submit`,
      headers: bearer(owner)
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toEqual({ status: "pending" });

    const detail = await app.inject({ url: `/api/v1/features/${draft.id}`, headers: bearer(owner) });
    expect(detail.json().status).toBe("pending");

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/features/${draft.id}/submit`,
      headers: bearer(owner)
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().detail).toBe("Revision is not eligible for submission");
  });

  it("creates revisions for published content while the old version stays public", async () => {
    const owner = backend.seedUser();
    const { feature } = backend.seedPublishedFeature(owner.id);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/features/${feature.id}/revisions`,
      headers: bearer(owner),
      payload: featurePayload({ title: "修订后的标题" })
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: expect.any(String), status: "draft" });
    const revisionId = created.json().id;

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/features/${feature.id}/revisions/${revisionId}/submit`,
      headers: bearer(owner)
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toEqual({ status: "pending" });

    // the previously published revision remains publicly visible
    const detail = await app.inject({ url: `/api/v1/features/${feature.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().title).toBe("南门长椅");
    expect(detail.json().status).toBe("published");

    // a second revision cannot be created while one waits for moderation
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/features/${feature.id}/revisions`,
      headers: bearer(owner),
      payload: featurePayload()
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().detail).toBe("A revision is already waiting for moderation");

    const history = await app.inject({ url: `/api/v1/features/${feature.id}/revisions`, headers: bearer(owner) });
    expect(history.statusCode).toBe(200);
    const rows = history.json();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: revisionId, revision_no: 2, status: "pending" });
    expect(rows[0]).toHaveProperty("submitted_at");
    expect(rows[0]).toHaveProperty("payload");
    expect(rows[1]).toMatchObject({ revision_no: 1, status: "published" });
  });

  it("restricts revision history to the author and moderators", async () => {
    const owner = backend.seedUser();
    const { feature } = backend.seedPublishedFeature(owner.id);

    const anonymous = await app.inject({ url: `/api/v1/features/${feature.id}/revisions` });
    expect(anonymous.statusCode).toBe(401);

    const stranger = backend.seedUser();
    const forbidden = await app.inject({ url: `/api/v1/features/${feature.id}/revisions`, headers: bearer(stranger) });
    expect(forbidden.statusCode).toBe(403);

    const moderator = backend.seedUser({ role: "moderator" });
    const allowed = await app.inject({ url: `/api/v1/features/${feature.id}/revisions`, headers: bearer(moderator) });
    expect(allowed.statusCode).toBe(200);
  });

  it("lists only the caller's own features with the legacy row shape", async () => {
    const owner = backend.seedUser();
    const other = backend.seedUser();
    const draft = await createDraft(owner);
    backend.seedPublishedFeature(other.id);

    const response = await app.inject({ url: "/api/v1/me/features", headers: bearer(owner) });
    expect(response.statusCode).toBe(200);
    const rows = response.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: draft.id,
      category_key: "bench",
      status: "draft",
      revision_no: 1,
      revision_status: "draft"
    });
    expect(rows[0]).toHaveProperty("payload");
    expect(rows[0]).toHaveProperty("rejection_reason_code");
    expect(rows[0]).toHaveProperty("moderation_notes");
  });

  it("soft-deletes features with their media and hides them afterwards", async () => {
    const owner = backend.seedUser();
    const media = backend.seedMedia(owner.id);
    const draft = await createDraft(owner, { mediaIds: [media.id] });

    const stranger = backend.seedUser();
    const forbidden = await app.inject({
      method: "DELETE",
      url: `/api/v1/features/${draft.id}`,
      headers: bearer(stranger)
    });
    expect(forbidden.statusCode).toBe(403);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/features/${draft.id}`,
      headers: bearer(owner)
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ status: "deleted" });

    const detail = await app.inject({ url: `/api/v1/features/${draft.id}`, headers: bearer(owner) });
    expect(detail.statusCode).toBe(404);

    const mine = await app.inject({ url: "/api/v1/me/features", headers: bearer(owner) });
    expect(mine.json()).toHaveLength(0);

    expect(backend.media.get(media.id)?.privacy_status).toBe("deleted");
    expect(backend.media.get(media.id)?.deleted_at).not.toBeNull();
    expect(backend.events.some((event) => event === `s3:delete:quarantine-test:${media.quarantine_object_key}`)).toBe(true);
    expect(backend.events.some((event) => event === `s3:delete:public-test:${media.public_object_key}`)).toBe(true);
    expect(backend.auditLogs.some((row) => row.action === "feature.deleted" && row.resource_id === draft.id)).toBe(true);
  });
});

describe("freshness confirmation contract", () => {
  it("records confirmations once per 90 days and summarizes them", async () => {
    const owner = backend.seedUser();
    const { feature } = backend.seedPublishedFeature(owner.id);
    const user = backend.seedUser();

    const recorded = await app.inject({
      method: "POST",
      url: `/api/v1/features/${feature.id}/confirmations`,
      headers: bearer(user),
      payload: { result: "still_accurate" }
    });
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json()).toEqual({ status: "recorded" });

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/features/${feature.id}/confirmations`,
      headers: bearer(user),
      payload: { result: "changed" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().detail).toBe("This feature was already confirmed within the last 90 days");

    const summary = await app.inject({ url: `/api/v1/features/${feature.id}/confirmations` });
    expect(summary.statusCode).toBe(200);
    const rows = summary.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "still_accurate", count: 1 });
    expect(rows[0]).toHaveProperty("latest_at");
  });

  it("only accepts confirmations for published features", async () => {
    const owner = backend.seedUser();
    const draft = await createDraft(owner);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/features/${draft.id}/confirmations`,
      headers: bearer(owner),
      payload: { result: "changed" }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().detail).toBe("Published feature not found");
  });

  it("flags features for review after three risky confirmations", async () => {
    const owner = backend.seedUser();
    const { feature } = backend.seedPublishedFeature(owner.id);
    for (const result of ["changed", "changed", "closed"]) {
      const reporter = backend.seedUser();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/features/${feature.id}/confirmations`,
        headers: bearer(reporter),
        payload: { result }
      });
      expect(response.statusCode).toBe(200);
    }
    expect(backend.features.get(feature.id)?.needs_review_at).not.toBeNull();

    const detail = await app.inject({ url: `/api/v1/features/${feature.id}` });
    expect(detail.json().needsReviewAt).not.toBeNull();
    expect(detail.json().confirmations).toEqual(
      expect.arrayContaining([
        { result: "changed", count: 2 },
        { result: "closed", count: 1 }
      ])
    );
  });
});
