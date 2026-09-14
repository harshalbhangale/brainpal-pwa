import { isParent } from "@brainpal/auth";
import { families, familyMembers, getDb } from "@brainpal/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { ApiError } from "../errors.js";

export async function registerFamilyRoutes(app: FastifyInstance) {
  app.get("/v1/me", async (request) => {
    const { principal } = request;
    return {
      memberId: principal.memberId,
      familyId: principal.familyId,
      role: principal.role,
      displayName: principal.displayName,
    };
  });

  app.get("/v1/families/current", async (request) => {
    const { principal } = request;
    const db = getDb();

    const [family] = await db
      .select()
      .from(families)
      .where(eq(families.id, principal.familyId))
      .limit(1);

    if (!family) {
      throw new ApiError(404, "FAMILY_NOT_FOUND", "family no longer exists");
    }

    const members = await db
      .select({
        id: familyMembers.id,
        role: familyMembers.role,
        status: familyMembers.status,
        displayName: familyMembers.displayName,
        avatarMascotId: familyMembers.avatarMascotId,
        avatarStyle: familyMembers.avatarStyle,
        avatarVersion: familyMembers.avatarVersion,
      })
      .from(familyMembers)
      .where(eq(familyMembers.familyId, principal.familyId));

    // A child sees only themselves. The roster is a parent's view.
    const visible = isParent(principal)
      ? members
      : members.filter((m) => m.id === principal.memberId);

    return {
      id: family.id,
      name: family.name,
      currency: family.currency,
      members: visible,
    };
  });
}
