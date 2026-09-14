import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { eq } from "drizzle-orm";

import {
  closePool,
  families,
  familyMembers,
  getDb,
  joinCodes,
  users,
} from "../dist/index.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);

/**
 * Drizzle wraps driver errors, so the violated constraint is on `cause`, not in
 * the message. Asserting on it directly keeps these tests honest: they fail if
 * the write succeeds *or* if it fails for some unrelated reason.
 */
function violates(constraint: string) {
  return (error: unknown) => {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    assert.equal(cause?.constraint, constraint);
    return true;
  };
}

describe("membership invariants", { skip: !hasDatabase }, () => {
  const db = getDb();
  let familyId: string;

  before(async () => {
    const [family] = await db
      .insert(families)
      .values({ name: `test-${crypto.randomUUID()}`, currency: "AUD" })
      .returning();
    familyId = family!.id;
  });

  after(async () => {
    await db.delete(families).where(eq(families.id, familyId));
    await closePool();
  });

  test("a child member exists before any user is bound to it", async () => {
    const [member] = await db
      .insert(familyMembers)
      .values({ familyId, role: "child", displayName: "Maya" })
      .returning();

    assert.equal(member!.userId, null);
    assert.equal(member!.status, "invited");
  });

  test("two unbound child slots do not collide", async () => {
    // The (family_id, user_id) unique index is partial. If it were not, a second
    // child added before signing in would fail on a null collision.
    await db
      .insert(familyMembers)
      .values({ familyId, role: "child", displayName: "Leo" });

    const members = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.familyId, familyId));

    assert.ok(members.filter((m) => m.userId === null).length >= 2);
  });

  test("one user cannot hold two memberships in the same family", async () => {
    const [user] = await db
      .insert(users)
      .values({ authSubject: `test-${crypto.randomUUID()}` })
      .returning();

    await db.insert(familyMembers).values({
      familyId,
      userId: user!.id,
      role: "parent",
      displayName: "Parent",
      status: "active",
    });

    await assert.rejects(
      db.insert(familyMembers).values({
        familyId,
        userId: user!.id,
        role: "co_guardian",
        displayName: "Parent again",
        status: "active",
      }),
      violates("family_members_family_user_key"),
    );
  });

  test("a join code is unique only while it is unredeemed", async () => {
    const [member] = await db
      .insert(familyMembers)
      .values({ familyId, role: "child", displayName: "Codeholder" })
      .returning();

    const code = `J${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    const expiresAt = new Date(Date.now() + 86_400_000);

    const [issued] = await db
      .insert(joinCodes)
      .values({ familyId, memberId: member!.id, code, expiresAt })
      .returning();

    await assert.rejects(
      db
        .insert(joinCodes)
        .values({ familyId, memberId: member!.id, code, expiresAt }),
      violates("join_codes_code_active_key"),
      "a live code must not be reissued",
    );

    // Once spent, the row is kept for audit and no longer blocks the value.
    await db
      .update(joinCodes)
      .set({ redeemedAt: new Date() })
      .where(eq(joinCodes.id, issued!.id));

    await db
      .insert(joinCodes)
      .values({ familyId, memberId: member!.id, code, expiresAt });
  });
});
