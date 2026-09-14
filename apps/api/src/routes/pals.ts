import { getDb, palActivations, palRegistry } from "@brainpal/database";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

export async function registerPalRoutes(app: FastifyInstance) {
  app.get("/v1/pals", async (request) => {
    const db = getDb();
    const { familyId } = request.principal;

    const rows = await db
      .select({
        id: palRegistry.id,
        name: palRegistry.name,
        description: palRegistry.description,
        available: palRegistry.available,
        active: palActivations.active,
        level: palActivations.level,
      })
      .from(palRegistry)
      // The family scope belongs in the join condition, not a where clause: a
      // left join filtered afterwards would either drop unactivated PALs or
      // match another family's activation row.
      .leftJoin(
        palActivations,
        and(
          eq(palActivations.palId, palRegistry.id),
          eq(palActivations.familyId, familyId),
        ),
      )
      .where(eq(palRegistry.available, true));

    return {
      pals: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        active: row.active ?? false,
        level: row.level ?? 0,
      })),
    };
  });
}
