import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closePool, getDb } from "./client.js";

/**
 * Applies pending migrations. Uses drizzle-orm's migrator rather than
 * `drizzle-kit migrate`, which exits 1 with no diagnostics on Node 26.
 * `drizzle-kit generate` is still how migrations are authored.
 */
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

try {
  await migrate(getDb(), { migrationsFolder });
  console.log("migrations applied");
} finally {
  await closePool();
}
