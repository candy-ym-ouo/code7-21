import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { AppError } from "../errors";
import { featureRoutes } from "./features";
import type { FeatureService } from "../features/service";

/**
 * 旧客户端契约回归：路由层保持原有路径、方法、状态码、响应结构
 * 和错误码。服务层被替换为记录调用的桩，认证中间件被替换为
 * 可控替身（不触碰数据库）。
 */

const authState = vi.hoisted(() => ({
  user: undefined as
    | undefined
    | { id: string; email: string; displayName: string; role: "contributor" | "moderator" | "admin"; status: "active"; emailVerified: boolean }
}));

vi.mock("../auth", async () => {
  const { AppError: AuthError } = await import("../errors");
  return {
    optionalAuth: async (request: { user?: unknown }) => {
      request.user = authState.user;
    },
    requireAuth: async (request: { user?: unknown }) => {
      if (!authState.user) throw new AuthError(401, "AUTH_REQUIRED", "Authentication required");
      request.user = authState.user;
    },
    requireVerifiedContributor: async (request: { user?: unknown }) => {
      if (!authState.user) throw new AuthError(401, "AUTH_REQUIRED", "Authentication required");
      if (!authState.user.emailVerified) throw new AuthError(403, "EMAIL_NOT_VERIFIED", "Email verification is required");
      request.user = authState.user;
    }
  };
});

const verifiedUser = {
  id: "user-1",
  email: "user@example.com",
  displayName: "测试用户",
  role: "contributor" as const,
  status: "active" as const,
  emailVerified: true
};

const detailFixture = {
  id: "feature-1",
  ownerId: "user-1",
  categoryKey: "bench",
  categoryName: "长椅",
  categoryIcon: "bench",
  status: "published",
  longitude: 116.404,
  latitude: 39.915,
  locationAccuracyM: 10,
  firstPublishedAt: null,
  freshnessExpiresAt: null,
  needsReviewAt: null,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-02T00:00:00.000Z"),
  title: "南门长椅",
  description: "有靠背和遮雨棚的长椅",
  condition: "good",
  tags: [],
  details: {},
  mediaIds: [],
  media: [],
  confirmations: []
};

function createServiceStub(overrides: Partial<FeatureService> = {}): FeatureService {
  return {
    listCategories: vi.fn(async () => [
      { key: "bench", name: "长椅", icon: "bench", detail_schema: {}, detail_schema_version: 1, sort_order: 10 }
    ]),
    searchPublished: vi.fn(async () => []),
    getFeatureDetail: vi.fn(async () => detailFixture),
    listRevisions: vi.fn(async () => []),
    listMyFeatures: vi.fn(async () => []),
    getConfirmations: vi.fn(async () => [{ result: "still_accurate", count: 2, latest_at: new Date("2026-09-10T00:00:00.000Z") }]),
    createDraft: vi.fn(async () => "feature-new"),
    updateDraft: vi.fn(async () => undefined),
    createRevision: vi.fn(async () => "revision-new"),
    submitRevision: vi.fn(async () => undefined),
    deleteFeature: vi.fn(async () => undefined),
    recordConfirmation: vi.fn(async () => undefined),
    ...overrides
  };
}

async function buildTestApp(service: FeatureService) {
  const app = Fastify({ logger: false });
  // 与 app.ts 相同的错误映射，保证旧客户端看到的错误结构不变
  app.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: "Request did not match the required schema",
        issues: error.issues
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        status: error.statusCode,
        code: error.code,
        detail: error.message,
        details: error.details
      });
    }
    return reply.code(500).send({ status: 500, code: "INTERNAL_ERROR", detail: "An unexpected error occurred" });
  });
  await app.register(featureRoutes, { service, prefix: "/api/v1" });
  return app;
}

const validBody = {
  categoryKey: "bench",
  title: "南门长椅",
  description: "有靠背和遮雨棚的长椅",
  longitude: 116.404,
  latitude: 39.915,
  locationAccuracyM: 10,
  observedAt: "2026-09-01T08:00:00.000Z",
  condition: "good"
};

const featureId = "9e3d4a6a-9f3b-4f5e-8b2a-1c2d3e4f5a6b";
const revisionId = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

beforeEach(() => {
  authState.user = undefined;
});

describe("公开查询契约", () => {
  it("GET /api/v1/categories 原样返回服务层结果", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: "/api/v1/categories" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { key: "bench", name: "长椅", icon: "bench", detail_schema: {}, detail_schema_version: 1, sort_order: 10 }
    ]);
  });

  it("GET /api/v1/features 解析 bbox、分类、状况和 limit", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/features?bbox=116.3,39.8,116.5,40&category=bench,%20quiet_corner&condition=good&limit=50"
    });
    expect(response.statusCode).toBe(200);
    expect(service.searchPublished).toHaveBeenCalledWith({
      bbox: [116.3, 39.8, 116.5, 40],
      categories: ["bench", "quiet_corner"],
      condition: "good",
      limit: 50
    });
  });

  it("GET /api/v1/features 默认 limit 为 250，支持跨 180 度经线", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: "/api/v1/features?bbox=178,10,-177,14" });
    expect(response.statusCode).toBe(200);
    expect(service.searchPublished).toHaveBeenCalledWith({
      bbox: [178, 10, -177, 14],
      categories: [],
      condition: undefined,
      limit: 250
    });
  });

  it.each([
    ["bbox=116.3,39.8,116.5", "bbox must contain four numbers"],
    ["bbox=116.3,39.8,116.3,40", "Invalid bbox order"],
    ["bbox=116.3,40,116.5,39.8", "Invalid bbox order"],
    ["bbox=200,10,201,20", "bbox is outside valid longitude/latitude ranges"],
    ["bbox=100,10,106,20", "bbox is too large"],
    ["bbox=100,10,105,20", "bbox is too large"]
  ])("非法 bbox %s 返回 400", async (bbox, detail) => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: `/api/v1/features?${bbox}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED", detail });
    expect(service.searchPublished).not.toHaveBeenCalled();
  });

  it("GET /api/v1/features 缺少 bbox 返回 400", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: "/api/v1/features" });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });

  it("GET /api/v1/features/:id 匿名访问不传用户", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: `/api/v1/features/${featureId}` });
    expect(response.statusCode).toBe(200);
    expect(service.getFeatureDetail).toHaveBeenCalledWith(featureId, undefined);
    expect(response.json()).toMatchObject({ id: "feature-1", title: "南门长椅" });
  });

  it("GET /api/v1/features/:id 登录用户传入服务层", async () => {
    authState.user = verifiedUser;
    const service = createServiceStub();
    const app = await buildTestApp(service);
    await app.inject({ method: "GET", url: `/api/v1/features/${featureId}` });
    expect(service.getFeatureDetail).toHaveBeenCalledWith(featureId, verifiedUser);
  });

  it("GET /api/v1/features/:id 非 uuid 返回 400", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: "/api/v1/features/not-a-uuid" });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });

  it("GET /api/v1/features/:id/confirmations 返回汇总", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: `/api/v1/features/${featureId}/confirmations` });
    expect(response.statusCode).toBe(200);
    expect(service.getConfirmations).toHaveBeenCalledWith(featureId);
    expect(response.json()).toEqual([{ result: "still_accurate", count: 2, latest_at: "2026-09-10T00:00:00.000Z" }]);
  });
});

describe("投稿契约", () => {
  beforeEach(() => {
    authState.user = verifiedUser;
  });

  it("POST /api/v1/features 创建草稿返回 201", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "POST", url: "/api/v1/features", payload: validBody });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: "feature-new", status: "draft" });
    expect(service.createDraft).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        categoryKey: "bench",
        observedAt: new Date("2026-09-01T08:00:00.000Z"),
        tags: [],
        details: {},
        mediaIds: []
      })
    );
  });

  it("POST /api/v1/features 未登录返回 401", async () => {
    authState.user = undefined;
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "POST", url: "/api/v1/features", payload: validBody });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("AUTH_REQUIRED");
    expect(service.createDraft).not.toHaveBeenCalled();
  });

  it("POST /api/v1/features 邮箱未验证返回 403", async () => {
    authState.user = { ...verifiedUser, emailVerified: false };
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "POST", url: "/api/v1/features", payload: validBody });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("POST /api/v1/features 请求体不合法返回 400", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/features",
      payload: { ...validBody, title: "短" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
    expect(service.createDraft).not.toHaveBeenCalled();
  });

  it("PATCH /api/v1/features/:id/draft 返回草稿状态", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/features/${featureId}/draft`,
      payload: validBody
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "draft" });
    expect(service.updateDraft).toHaveBeenCalledWith("user-1", featureId, expect.objectContaining({ title: "南门长椅" }));
  });

  it("POST /api/v1/features/:id/submit 返回 pending", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "POST", url: `/api/v1/features/${featureId}/submit` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "pending" });
    expect(service.submitRevision).toHaveBeenCalledWith("user-1", featureId);
  });

  it("POST /api/v1/features/:id/revisions 创建修订返回 201", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/features/${featureId}/revisions`,
      payload: validBody
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: "revision-new", status: "draft" });
    expect(service.createRevision).toHaveBeenCalledWith("user-1", featureId, expect.objectContaining({ categoryKey: "bench" }));
  });

  it("POST /api/v1/features/:id/revisions/:revisionId/submit 返回 pending", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/features/${featureId}/revisions/${revisionId}/submit`
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "pending" });
    expect(service.submitRevision).toHaveBeenCalledWith("user-1", featureId, revisionId);
  });

  it("GET /api/v1/features/:id/revisions 需要登录", async () => {
    authState.user = undefined;
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: `/api/v1/features/${featureId}/revisions` });
    expect(response.statusCode).toBe(401);
    expect(service.listRevisions).not.toHaveBeenCalled();
  });

  it("GET /api/v1/features/:id/revisions 返回修订历史", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: `/api/v1/features/${featureId}/revisions` });
    expect(response.statusCode).toBe(200);
    expect(service.listRevisions).toHaveBeenCalledWith(verifiedUser, featureId);
  });

  it("DELETE /api/v1/features/:id 返回 deleted", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "DELETE", url: `/api/v1/features/${featureId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "deleted" });
    expect(service.deleteFeature).toHaveBeenCalledWith(verifiedUser, featureId);
  });

  it("GET /api/v1/me/features 返回我的投稿", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "GET", url: "/api/v1/me/features" });
    expect(response.statusCode).toBe(200);
    expect(service.listMyFeatures).toHaveBeenCalledWith("user-1");
  });

  it("POST /api/v1/features/:id/confirmations 记录确认", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/features/${featureId}/confirmations`,
      payload: { result: "changed", note: "长椅被移走了" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "recorded" });
    expect(service.recordConfirmation).toHaveBeenCalledWith("user-1", featureId, { result: "changed", note: "长椅被移走了" });
  });

  it("POST /api/v1/features/:id/confirmations 非法结果返回 400", async () => {
    const service = createServiceStub();
    const app = await buildTestApp(service);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/features/${featureId}/confirmations`,
      payload: { result: "unknown_value" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_FAILED");
  });
});

describe("错误契约", () => {
  beforeEach(() => {
    authState.user = verifiedUser;
  });

  it("服务层 AppError 映射为对应状态码和 code", async () => {
    const service = createServiceStub({
      createDraft: vi.fn(async () => {
        throw new AppError(409, "MEDIA_NOT_READY", "All media must finish privacy processing before submission", {
          mediaStatus: "processing"
        });
      })
    });
    const app = await buildTestApp(service);
    const response = await app.inject({ method: "POST", url: "/api/v1/features", payload: validBody });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "MEDIA_NOT_READY",
      detail: "All media must finish privacy processing before submission",
      details: { mediaStatus: "processing" }
    });
  });

  it("NOT_FOUND 和 FORBIDDEN 保持旧版错误结构", async () => {
    const service = createServiceStub({
      submitRevision: vi.fn(async () => {
        throw new AppError(404, "NOT_FOUND", "Feature not found");
      })
    });
    const app = await buildTestApp(service);
    const missing = await app.inject({ method: "POST", url: `/api/v1/features/${featureId}/submit` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "NOT_FOUND", detail: "Feature not found" });

    const forbiddenService = createServiceStub({
      deleteFeature: vi.fn(async () => {
        throw new AppError(403, "FORBIDDEN", "Permission denied");
      })
    });
    const forbiddenApp = await buildTestApp(forbiddenService);
    const denied = await forbiddenApp.inject({ method: "DELETE", url: `/api/v1/features/${featureId}` });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "FORBIDDEN", detail: "Permission denied" });
  });
});
