import { pool, transaction } from "../db";
import { config } from "../config";
import { deleteObject, publicMediaUrl } from "../storage";
import { createFeatureStore } from "./store";
import { createFeatureService } from "./service";

/**
 * 生产装配：连接池读取、单事务写路径、S3 对象清理。
 * 对象存储清理发生在数据库事务提交之后，失败不影响已提交的删除。
 */
export const featureService = createFeatureService({
  runInTransaction: (fn) => transaction((client) => fn(createFeatureStore(client))),
  readStore: createFeatureStore(pool),
  mediaUrl: publicMediaUrl,
  removeMediaObjects: async (items) => {
    const removals = items.flatMap((item) => [
      deleteObject(config.S3_QUARANTINE_BUCKET, item.quarantine_object_key),
      item.processed_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.processed_object_key) : Promise.resolve(),
      item.thumbnail_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.thumbnail_object_key) : Promise.resolve(),
      item.public_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_object_key) : Promise.resolve(),
      item.public_thumbnail_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_thumbnail_object_key) : Promise.resolve()
    ]);
    await Promise.allSettled(removals);
  }
});
