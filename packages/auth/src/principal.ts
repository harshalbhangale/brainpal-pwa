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

/**
 * Identity without authorisation. A verified subject always has a user row, but
 * may not belong to a family yet — that is the state a parent is in between
 * signing in and creating one, and a child is in before redeeming a join code.
 *
 * Nothing but the bootstrap routes may use this: it proves who someone is and
 * says nothing about what they may see.
 */
export async function ensureUser(
  db: Database,
  authSubject: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authSubject, authSubject))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(users)
    .values({ authSubject })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (created) return created.id;

  // Lost an insert race; the row now exists.
  const [raced] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authSubject, authSubject))
    .limit(1);
  if (!raced) throw new AuthError("NO_USER", "could not create user");
  return raced.id;
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
