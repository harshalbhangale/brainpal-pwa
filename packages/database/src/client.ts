import { readFileSync } from "node:fs";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema/index.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

/**
 * Locally a single DATABASE_URL. In production the parts arrive separately —
 * the password straight from Secrets Manager — so nothing has to URL-encode a
 * generated password, and TLS is verified against the RDS certificate bundle.
 */
function connectionConfig(): pg.PoolConfig {
  const caPath = process.env["DATABASE_SSL_CA"];
  const ssl = caPath ? { ca: readFileSync(caPath, "utf8"), rejectUnauthorized: true } : undefined;

  const url = process.env["DATABASE_URL"];
  if (url) return { connectionString: url, ...(ssl ? { ssl } : {}) };

  const host = process.env["DB_HOST"];
  if (!host) throw new Error("DATABASE_URL or DB_HOST is missing");
  return {
    host,
    port: Number(process.env["DB_PORT"] ?? 5432),
    database: process.env["DB_NAME"] ?? "brainpal",
    user: process.env["DB_USER"],
    password: process.env["DB_PASSWORD"],
    ...(ssl ? { ssl } : {}),
  };
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      ...connectionConfig(),
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
