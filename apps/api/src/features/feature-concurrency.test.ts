import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", async () => (await import("./testing/memory-backend")).dbMock);
vi.mock("../audit", async () => (await import("./testing/memory-backend")).auditMock);
vi.mock("../storage", async () => (await import("./testing/memory-backend")).storageMock);
vi.mock("./feature-store", async () => (await import("./testing/memory-backend")).storeMock);

import type { FeaturePayload } from "@map/shared/contracts";
import { AppError } from "../errors";
import * as service from "./feature-service";
import { backend } from "./testing/memory-backend";

/**
 * Concurrency and transaction-boundary regression for the feature service.
 *
 * The in-memory backend models PostgreSQL row locks (`SELECT ... FOR
 * UPDATE`) as per-row async queues and rolls transactions back through an
 * undo log, so these tests exercise the same interleavings the real
 * database would produce under concurrent submissions.
 */

function payload(overrides: Partial<FeaturePayload> = {}): FeaturePayload {
  return {
    categoryKey: "bench",
    title: "南门长椅",
    description: "有靠背和扶手的长椅，靠近南门入口。",
    longitude: 116.404,
    latitude: 39.915,
    locationAccuracyM: 5,
    observedAt: new Date("2026-09-20T08:00:00.000Z"),
    condition: "good",
    tags: [],
    details: {},
    mediaIds: [],
    ...overrides
  };
}

function commitsWith(statement: string) {
  return backend.journal.filter(
    (entry) => entry.event === "commit" && entry.statements.includes(statement)
  );
}

function rollbacks() {
  return backend.journal.filter((entry) => entry.event === "rollback");
}

beforeEach(() => {
  backend.reset();
  backend.seedCategory("bench");
});

describe("concurrent submissions", () => {
  it("allows exactly one of many concurrent submits of the same draft", async () => {
    const user = backend.seedUser();
    const featureId = await service.createDraft(user.id, payload());

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.submitFeature(user.id, featureId))
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const result of rejected) {
      const reason = (result as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(AppError);
      expect(reason).toMatchObject({ statusCode: 409, code: "CONFLICT" });
    }

    // final state is consistent: one pending revision on a pending feature
    expect(backend.features.get(featureId)?.status).toBe("pending");
    const revision = backend.latestRevisionOf(featureId);
    expect(revision?.status).toBe("pending");
    expect(revision?.submitted_at).not.toBeNull();

    // transaction journal: one committed submit, four rolled back
    expect(commitsWith("markRevisionPending")).toHaveLength(1);
    expect(rollbacks()).toHaveLength(4);
  });

  it("does not block submissions of different features", async () => {
    const user = backend.seedUser();
    const first = await service.createDraft(user.id, payload());
    const second = await service.createDraft(user.id, payload());

    const results = await Promise.allSettled([
      service.submitFeature(user.id, first),
      service.submitFeature(user.id, second)
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(backend.features.get(first)?.status).toBe("pending");
    expect(backend.features.get(second)?.status).toBe("pending");
  });

  it("serializes concurrent revision creation with gapless revision numbers", async () => {
    const user = backend.seedUser();
    const { feature } = backend.seedPublishedFeature(user.id);

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        service.createRevision(user.id, feature.id, payload({ title: `修订 ${index}` }))
      )
    );

    for (const result of results) {
      expect(result.status, result.status === "rejected" ? String(result.reason) : "").toBe("fulfilled");
    }
    const numbers = [...backend.revisions.values()]
      .filter((revision) => revision.feature_id === feature.id)
      .map((revision) => revision.revision_no)
      .sort((a, b) => a - b);
    // no duplicates and no gaps: the unique (feature_id, revision_no)
    // constraint is never violated because writers serialize on the feature row
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    expect(rollbacks()).toHaveLength(0);
  });

  it("resolves a submit/delete race into a consistent final state", async () => {
    const user = backend.seedUser();
    const media = backend.seedMedia(user.id);
    const featureId = await service.createDraft(user.id, payload({ mediaIds: [media.id] }));
    const authUser = {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      status: user.status,
      emailVerified: true
    } as const;

    // submit first: the submit commits, then the delete proceeds
    const [submitResult, deleteResult] = await Promise.allSettled([
      service.submitFeature(user.id, featureId),
      service.deleteFeature(authUser, featureId)
    ]);
    expect(submitResult.status).toBe("fulfilled");
    expect(deleteResult.status).toBe("fulfilled");
    expect(backend.features.get(featureId)?.status).toBe("deleted");
    expect(backend.features.get(featureId)?.deleted_at).not.toBeNull();
    expect(backend.latestRevisionOf(featureId)?.status).toBe("pending");
    expect(backend.media.get(media.id)?.privacy_status).toBe("deleted");
  });

  it("makes a concurrent submit observe a committed delete", async () => {
    const user = backend.seedUser();
    const featureId = await service.createDraft(user.id, payload());
    const authUser = {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      status: user.status,
      emailVerified: true
    } as const;

    // delete first: the submitter's FOR UPDATE re-check sees the deleted row
    const [deleteResult, submitResult] = await Promise.allSettled([
      service.deleteFeature(authUser, featureId),
      service.submitFeature(user.id, featureId)
    ]);
    expect(deleteResult.status).toBe("fulfilled");
    expect(submitResult.status).toBe("rejected");
    expect((submitResult as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND"
    });
    expect(backend.features.get(featureId)?.status).toBe("deleted");
    expect(backend.latestRevisionOf(featureId)?.status).toBe("draft");
  });

  it("serializes a draft update against a submit", async () => {
    const user = backend.seedUser();
    const featureId = await service.createDraft(user.id, payload());

    // update first: the submit then sees the updated payload
    const [updateResult, submitResult] = await Promise.allSettled([
      service.updateDraft(user.id, featureId, payload({ title: "并发更新标题" })),
      service.submitFeature(user.id, featureId)
    ]);
    expect(updateResult.status).toBe("fulfilled");
    expect(submitResult.status).toBe("fulfilled");
    const revision = backend.latestRevisionOf(featureId);
    expect(revision?.status).toBe("pending");
    expect(revision?.payload?.title).toBe("并发更新标题");
  });

  it("rejects a draft update that loses the race against a submit", async () => {
    const user = backend.seedUser();
    const featureId = await service.createDraft(user.id, payload());

    // submit first: the update then finds the feature no longer editable
    const [submitResult, updateResult] = await Promise.allSettled([
      service.submitFeature(user.id, featureId),
      service.updateDraft(user.id, featureId, payload({ title: "迟到的更新" }))
    ]);
    expect(submitResult.status).toBe("fulfilled");
    expect(updateResult.status).toBe("rejected");
    expect((updateResult as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      code: "CONFLICT"
    });
    expect(backend.latestRevisionOf(featureId)?.payload?.title).toBe("南门长椅");
  });
});

describe("transaction boundaries", () => {
  it("commits a draft creation as a single transaction", async () => {
    const user = backend.seedUser();
    const mediaA = backend.seedMedia(user.id);
    const mediaB = backend.seedMedia(user.id);

    const featureId = await service.createDraft(user.id, payload({ mediaIds: [mediaA.id, mediaB.id] }));

    const commits = backend.journal.filter((entry) => entry.event === "commit");
    expect(commits).toHaveLength(1);
    expect(commits[0]!.statements).toEqual([
      "isActiveCategory",
      "findOwnedMedia",
      "insertFeature",
      "insertRevision",
      "replaceRevisionMedia",
      "audit:feature.draft_created"
    ]);
    // media binding happened inside the same transaction
    const revision = backend.latestRevisionOf(featureId);
    expect(
      backend.revisionMedia
        .filter((row) => row.revision_id === revision!.id)
        .map((row) => row.media_id)
        .sort()
    ).toEqual([mediaA.id, mediaB.id].sort());
    expect(backend.auditLogs).toHaveLength(1);
  });

  it("rolls back a draft creation completely on validation failure", async () => {
    const user = backend.seedUser();

    await expect(
      service.createDraft(user.id, payload({ categoryKey: "drinking_water" }))
    ).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });

    expect(backend.features.size).toBe(0);
    expect(backend.revisions.size).toBe(0);
    expect(backend.revisionMedia).toHaveLength(0);
    expect(backend.auditLogs).toHaveLength(0);
    expect(rollbacks()).toHaveLength(1);
    expect(commitsWith("insertFeature")).toHaveLength(0);
  });

  it("rolls back media rebinding when a draft update fails mid-transaction", async () => {
    const user = backend.seedUser();
    const original = backend.seedMedia(user.id);
    const featureId = await service.createDraft(user.id, payload({ mediaIds: [original.id] }));
    const revisionId = backend.latestRevisionOf(featureId)!.id;
    const foreign = backend.seedMedia(backend.seedUser().id);

    await expect(
      service.updateDraft(user.id, featureId, payload({ mediaIds: [foreign.id] }))
    ).rejects.toMatchObject({ statusCode: 400 });

    // the original binding survives: replaceRevisionMedia never ran, and the
    // failed transaction left no partial writes behind
    expect(backend.revisionMedia.filter((row) => row.revision_id === revisionId)).toEqual([
      { revision_id: revisionId, media_id: original.id, sort_order: 0 }
    ]);
    expect(backend.latestRevisionOf(featureId)?.status).toBe("draft");
  });

  it("cleans up object storage only after the delete transaction commits", async () => {
    const user = backend.seedUser();
    const media = backend.seedMedia(user.id);
    const featureId = await service.createDraft(user.id, payload({ mediaIds: [media.id] }));
    const authUser = {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      status: user.status,
      emailVerified: true
    } as const;

    backend.events = [];
    await service.deleteFeature(authUser, featureId);

    const commitIndex = backend.events.findIndex((event) => event.endsWith(":commit"));
    const firstS3Index = backend.events.findIndex((event) => event.startsWith("s3:delete:"));
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(firstS3Index).toBeGreaterThan(commitIndex);
    // quarantine originals plus derived and public copies are all removed
    expect(backend.events.filter((event) => event.startsWith("s3:delete:"))).toHaveLength(5);
  });

  it("does not touch object storage when the delete transaction rolls back", async () => {
    const user = backend.seedUser();
    const authUser = {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      status: user.status,
      emailVerified: true
    } as const;

    backend.events = [];
    await expect(service.deleteFeature(authUser, crypto.randomUUID())).rejects.toMatchObject({
      statusCode: 404
    });
    expect(backend.events.some((event) => event.startsWith("s3:delete:"))).toBe(false);
    expect(backend.events.some((event) => event.endsWith(":rollback"))).toBe(true);
  });
});
