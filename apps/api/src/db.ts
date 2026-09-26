import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { config } from "./config";

const { Pool } = pg;

/**
 * Minimal query interface shared by the connection pool and a transaction
 * client. Storage-layer functions accept this so the same query can run
 * standalone (pool) or inside a transaction (client) without changes.
 */
export type Queryable = Pick<PoolClient, "query">;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000
});

pool.on("error", (error) => {
  console.error({ error }, "unexpected PostgreSQL pool error");
});

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values);
}

export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}
