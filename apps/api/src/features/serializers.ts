import type { z } from "zod";
import type { createFeatureSchema } from "@map/shared/contracts";
import { AppError } from "../errors";

export type FeaturePayloadInput = z.infer<typeof createFeatureSchema>;

export type MediaRow = {
  id: string;
  privacy_status: string;
  public_object_key: string | null;
  public_thumbnail_object_key: string | null;
};

export type MediaUrlBuilder = (key: string | null | undefined) => string | null;

export function serializeMedia(media: MediaRow[] | null | undefined, mediaUrl: MediaUrlBuilder) {
  return (media ?? []).map((item) => ({
    id: item.id,
    status: item.privacy_status,
    url: mediaUrl(item.public_object_key),
    thumbnailUrl: mediaUrl(item.public_thumbnail_object_key)
  }));
}

export function payloadWithDate(input: FeaturePayloadInput) {
  return {
    ...input,
    observedAt: input.observedAt.toISOString()
  };
}

export function bboxFromString(value: string): [number, number, number, number] {
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
