import type { FamilyRole } from "@brainpal/contracts";
import { type Database, familyMembers, users } from "@brainpal/database";
import { and, eq } from "drizzle-orm";

import { AuthError } from "./verifier.js";

/**
 * Who the request is, and what they are allowed to be. Every field here is
 * derived server-side from `family_members` — none of it is readable from a
 * request body, query string or token claim.
 */
export interface Principal {
  userId: string;
  memberId: string;
  familyId: string;
  role: FamilyRole;
  displayName: string;
}

export async function resolvePrincipal(
  db: Database,
  authSubject: string,
): Promise<Principal> {
  const rows = await db
    .select({
      userId: users.id,
      memberId: familyMembers.id,
      familyId: familyMembers.familyId,
      role: familyMembers.role,
      displayName: familyMembers.displayName,
    })
    .from(users)
    .innerJoin(familyMembers, eq(familyMembers.userId, users.id))
    .where(
      and(eq(users.authSubject, authSubject), eq(familyMembers.status, "active")),
    )
    .limit(1);

  const principal = rows[0];
  if (!principal) {
    throw new AuthError("NO_MEMBERSHIP", "no active family membership");
  }
  return principal;
}

export function requireRole(
  principal: Principal,
  ...allowed: readonly FamilyRole[]
): void {
  if (!allowed.includes(principal.role)) {
    throw new AuthError("FORBIDDEN_ROLE", `requires ${allowed.join(" or ")}`);
  }
}

export function isParent(principal: Principal): boolean {
  return principal.role === "parent" || principal.role === "co_guardian";
}

/**
 * A child may only ever act on themselves. Parents may act on anyone in their
 * own family — and on nobody outside it.
 */
export function assertCanActOn(
  principal: Principal,
  subjectMemberId: string,
): void {
  if (isParent(principal)) return;
  if (principal.memberId !== subjectMemberId) {
    throw new AuthError("CROSS_MEMBER_FORBIDDEN", "not your record");
  }
}
