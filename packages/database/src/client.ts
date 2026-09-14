import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema/index.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) throw new Error("DATABASE_URL is missing");
    pool = new Pool({
      connectionString,
      max: Number(process.env["DB_POOL_MAX"] ?? 5),
      connectionTimeoutMillis: 8_000,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Database = ReturnType<typeof getDb>;

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
