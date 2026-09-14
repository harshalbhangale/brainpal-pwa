import { randomBytes } from "node:crypto";

import { AvatarSelection, ChildAdd, FamilyCreate } from "@brainpal/contracts";
import { isParent } from "@brainpal/auth";
import {
  families,
  familyMembers,
  getDb,
  joinCodes,
  palActivations,
} from "@brainpal/database";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ApiError } from "../errors.js";

/** Unambiguous alphabet: no O/0, I/1, so a code read aloud survives the trip. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function newJoinCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Routes that run before a membership exists. They are mounted behind
 * `identify` rather than `authenticate`, so each one must establish its own
 * authorisation — there is no principal to lean on.
 */
export async function registerBootstrapRoutes(app: FastifyInstance) {
  app.post("/v1/onboarding/family", async (request) => {
    const parsed = FamilyCreate.shape.payload.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "bad family", {
        issues: parsed.error.issues,
      });
    }

    const db = getDb();
    const { userId } = request;

    // One family per user in Phase 1. Multi-family comes with invitations.
    const [existing] = await db
      .select({ id: familyMembers.id })
      .from(familyMembers)
      .where(eq(familyMembers.userId, userId))
      .limit(1);
    if (existing) {
      throw new ApiError(409, "ALREADY_IN_FAMILY", "you already have a family");
    }

    const [family] = await db
      .insert(families)
      .values({ name: parsed.data.familyName, currency: parsed.data.currency })
      .returning();

    const [member] = await db
      .insert(familyMembers)
      .values({
        familyId: family!.id,
        userId,
        role: "parent",
        displayName: parsed.data.familyName,
        status: "active",
      })
      .returning();

    return { familyId: family!.id, memberId: member!.id, role: "parent" };
  });

  app.post("/v1/join", async (request) => {
    const parsed = z
      .object({ code: z.string().min(4).max(16) })
      .safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "bad join code");
    }

    const db = getDb();
    const code = parsed.data.code.trim().toUpperCase();

    const [live] = await db
      .select()
      .from(joinCodes)
      .where(eq(joinCodes.code, code))
      .limit(1);

    // One message for every failure mode: a wrong code, a spent code and an
    // expired code are indistinguishable, so codes cannot be probed.
    const invalid = new ApiError(404, "INVALID_CODE", "that code does not work");
    if (!live || live.redeemedAt || live.expiresAt.getTime() < Date.now()) {
      throw invalid;
    }

    const [member] = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, live.memberId))
      .limit(1);
    if (!member || member.userId) throw invalid;

    await db
      .update(familyMembers)
      .set({ userId: request.userId, status: "active", updatedAt: new Date() })
      .where(eq(familyMembers.id, member.id));

    await db
      .update(joinCodes)
      .set({ redeemedAt: new Date(), redeemedByUserId: request.userId })
      .where(eq(joinCodes.id, live.id));

    return { familyId: member.familyId, memberId: member.id, role: member.role };
  });
}

/** Routes that require a proven membership. */
export async function registerFamilyWriteRoutes(app: FastifyInstance) {
  app.post("/v1/families/current/children", async (request) => {
    const { principal } = request;
    if (!isParent(principal)) {
      throw new ApiError(403, "FORBIDDEN_ROLE", "only a parent may add a child");
    }

    const parsed = ChildAdd.shape.payload.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "bad child", {
        issues: parsed.error.issues,
      });
    }

    const db = getDb();
    const [member] = await db
      .insert(familyMembers)
      .values({
        familyId: principal.familyId,
        role: "child",
        status: "invited",
        displayName: parsed.data.displayName,
        ...(parsed.data.dateOfBirth
          ? { dateOfBirth: parsed.data.dateOfBirth }
          : {}),
      })
      .returning();

    const code = newJoinCode();
    await db.insert(joinCodes).values({
      familyId: principal.familyId,
      memberId: member!.id,
      code,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });

    return {
      member: {
        id: member!.id,
        displayName: member!.displayName,
        role: member!.role,
        status: member!.status,
      },
      joinCode: code,
    };
  });

  app.post("/v1/members/:id/avatar", async (request) => {
    const { principal } = request;
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiError(400, "INVALID_REQUEST", "bad member");

    const parsed = AvatarSelection.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "bad avatar", {
        issues: parsed.error.issues,
      });
    }

    // A child may dress only themselves; a parent may dress anyone in their own
    // family. The family predicate is in the where clause, so a member id from
    // another family updates nothing.
    if (!isParent(principal) && principal.memberId !== params.data.id) {
      throw new ApiError(403, "CROSS_MEMBER_FORBIDDEN", "not your avatar");
    }

    const db = getDb();
    const [updated] = await db
      .update(familyMembers)
      .set({
        avatarMascotId: parsed.data.mascotId,
        avatarStyle: parsed.data.style,
        avatarVersion: parsed.data.version,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(familyMembers.id, params.data.id),
          eq(familyMembers.familyId, principal.familyId),
        ),
      )
      .returning();

    if (!updated) throw new ApiError(404, "MEMBER_NOT_FOUND", "no such member");

    return {
      id: updated.id,
      avatarMascotId: updated.avatarMascotId,
      avatarStyle: updated.avatarStyle,
      avatarVersion: updated.avatarVersion,
    };
  });

  app.post("/v1/pals/:id/activate", async (request) => {
    const { principal } = request;
    if (!isParent(principal)) {
      throw new ApiError(403, "FORBIDDEN_ROLE", "only a parent may activate");
    }

    const params = z
      .object({ id: z.enum(["moneypal", "tutorpal"]) })
      .safeParse(request.params);
    if (!params.success) throw new ApiError(404, "PAL_NOT_FOUND", "no such pal");

    const db = getDb();
    const [activation] = await db
      .insert(palActivations)
      .values({
        familyId: principal.familyId,
        palId: params.data.id,
        active: true,
        level: 1,
        activatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [palActivations.familyId, palActivations.palId],
        set: { active: true, updatedAt: new Date() },
      })
      .returning();

    return { id: activation!.palId, active: activation!.active };
  });
}
