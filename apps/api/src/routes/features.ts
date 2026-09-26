import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createFeatureSchema } from "@map/shared/contracts";
import { optionalAuth, requireAuth, requireVerifiedContributor } from "../auth";
import { bboxFromString } from "../features/serializers";
import type { FeatureService } from "../features/service";

export type FeatureRoutesOptions = {
  service?: FeatureService;
};

export async function featureRoutes(app: FastifyInstance, options: FeatureRoutesOptions = {}) {
  const service = options.service ?? (await import("../features/runtime")).featureService;

  app.get("/categories", async () => service.listCategories());

  app.get("/features", async (request) => {
    const input = z.object({
      bbox: z.string(),
      category: z.string().optional(),
      condition: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(250)
    }).parse(request.query);

    const bbox = bboxFromString(input.bbox);
    const categories = input.category?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
    return service.searchPublished({ bbox, categories, condition: input.condition, limit: input.limit });
  });

  app.get("/features/:id", { preHandler: optionalAuth }, async (request) => {
    const input = z.object({ id: z.string().uuid() }).parse(request.params);
    return service.getFeatureDetail(input.id, request.user);
  });

  app.post("/features", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const input = createFeatureSchema.parse(request.body);
    const featureId = await service.createDraft(request.user!.id, input);
    return reply.code(201).send({ id: featureId, status: "draft" });
  });

  app.patch("/features/:id/draft", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = createFeatureSchema.parse(request.body);
    await service.updateDraft(request.user!.id, params.id, input);
    return { status: "draft" };
  });

  app.post("/features/:id/submit", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await service.submitRevision(request.user!.id, params.id);
    return { status: "pending" };
  });

  app.post("/features/:id/revisions", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = createFeatureSchema.parse(request.body);
    const revisionId = await service.createRevision(request.user!.id, params.id, input);
    return reply.code(201).send({ id: revisionId, status: "draft" });
  });

  app.post("/features/:id/revisions/:revisionId/submit", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    await service.submitRevision(request.user!.id, params.id, params.revisionId);
    return { status: "pending" };
  });

  app.get("/features/:id/revisions", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return service.listRevisions(request.user!, params.id);
  });

  app.delete("/features/:id", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await service.deleteFeature(request.user!, params.id);
    return { status: "deleted" };
  });

  app.get("/me/features", { preHandler: requireAuth }, async (request) => {
    return service.listMyFeatures(request.user!.id);
  });

  app.get("/features/:id/confirmations", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return service.getConfirmations(params.id);
  });

  app.post("/features/:id/confirmations", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      result: z.enum(["still_accurate", "changed", "closed"]),
      note: z.string().trim().max(500).optional()
    }).parse(request.body);

    await service.recordConfirmation(request.user!.id, params.id, input);
    return { status: "recorded" };
  });
}
