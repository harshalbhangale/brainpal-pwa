import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { mockToken } from "@brainpal/auth";
import {
  closePool,
  families,
  familyMembers,
  getDb,
  palActivations,
  seedPalRegistry,
  threads,
  users,
} from "@brainpal/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../dist/app.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
process.env["MOCK_AUTH"] = "true";

describe("request scoping", { skip: !hasDatabase }, () => {
  const db = getDb();
  let app: FastifyInstance;

  // Two families, so every "can't see it" assertion has something real to fail
  // against rather than an empty database.
  const ours = { familyId: "", parent: "", maya: "", leo: "", thread: "" };
  const theirs = { familyId: "", parent: "" };

  async function makeMember(
    familyId: string,
    role: "parent" | "child",
    displayName: string,
  ) {
    const subject = `test-${crypto.randomUUID()}`;
    const [user] = await db.insert(users).values({ authSubject: subject }).returning();
    const [member] = await db
      .insert(familyMembers)
      .values({ familyId, userId: user!.id, role, displayName, status: "active" })
      .returning();
    return { memberId: member!.id, token: mockToken(subject) };
  }

  before(async () => {
    await seedPalRegistry();
    app = await buildApp();
    await app.ready();

    const [a] = await db
      .insert(families)
      .values({ name: "Bhangale", currency: "AUD" })
      .returning();
    const [b] = await db
      .insert(families)
      .values({ name: "Other", currency: "AUD" })
      .returning();
    ours.familyId = a!.id;
    theirs.familyId = b!.id;

    const parent = await makeMember(ours.familyId, "parent", "Parent");
    const maya = await makeMember(ours.familyId, "child", "Maya");
    const leo = await makeMember(ours.familyId, "child", "Leo");
    ours.parent = parent.token;
    ours.maya = maya.token;
    ours.leo = leo.token;

    const otherParent = await makeMember(theirs.familyId, "parent", "Stranger");
    theirs.parent = otherParent.token;

    // A thread about Maya, and MoneyPAL active only for the other family.
    const [thread] = await db
      .insert(threads)
      .values({
        familyId: ours.familyId,
        subjectMemberId: maya.memberId,
        ownerPal: "moneypal",
        title: "Saving for a bike",
      })
      .returning();
    ours.thread = thread!.id;

    await db.insert(palActivations).values({
      familyId: theirs.familyId,
      palId: "moneypal",
      active: true,
      level: 2,
    });
  });

  after(async () => {
    await app.close();
    await db.delete(families).where(eq(families.id, ours.familyId));
    await db.delete(families).where(eq(families.id, theirs.familyId));
    await closePool();
  });

  const get = (url: string, token?: string) =>
    app.inject({
      method: "GET",
      url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  test("health needs no token", async () => {
    const res = await get("/health");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      status: "ok",
      service: "brainpal-api",
      version: "0.1.0",
    });
  });

  test("a protected route refuses an anonymous request", async () => {
    assert.equal((await get("/v1/me")).statusCode, 401);
  });

  test("a token with no membership is refused", async () => {
    const orphan = `test-${crypto.randomUUID()}`;
    await db.insert(users).values({ authSubject: orphan });
    const res = await get("/v1/me", mockToken(orphan));
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "NO_MEMBERSHIP");
  });

  test("role comes from the database, not the caller", async () => {
    const res = await get("/v1/me", ours.maya);
    assert.equal(res.json().role, "child");
  });

  test("a parent sees the whole roster", async () => {
    const res = await get("/v1/families/current", ours.parent);
    assert.equal(res.json().members.length, 3);
  });

  test("a child sees only themselves in the roster", async () => {
    const res = await get("/v1/families/current", ours.maya);
    const members = res.json().members;
    assert.equal(members.length, 1);
    assert.equal(members[0].displayName, "Maya");
  });

  test("a parent sees a thread about their child", async () => {
    const res = await get(`/v1/threads/${ours.thread}`, ours.parent);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().title, "Saving for a bike");
  });

  test("a sibling cannot read another child's thread", async () => {
    const res = await get(`/v1/threads/${ours.thread}`, ours.leo);
    assert.equal(res.statusCode, 404);
  });

  test("another family's parent cannot read the thread", async () => {
    const res = await get(`/v1/threads/${ours.thread}`, theirs.parent);
    assert.equal(res.statusCode, 404);
  });

  test("the thread list is scoped to the child it is about", async () => {
    assert.equal((await get("/v1/threads", ours.maya)).json().threads.length, 1);
    assert.equal((await get("/v1/threads", ours.leo)).json().threads.length, 0);
    assert.equal((await get("/v1/threads", theirs.parent)).json().threads.length, 0);
  });

  test("PAL activation does not leak across families", async () => {
    // MoneyPAL is active for the other family only. If the activation join were
    // not family-scoped, this would report active for us too.
    const mine = (await get("/v1/pals", ours.parent)).json().pals;
    const money = mine.find((p: { id: string }) => p.id === "moneypal");
    assert.equal(money.active, false);
    assert.equal(money.level, 0);

    const other = (await get("/v1/pals", theirs.parent)).json().pals;
    assert.equal(other.find((p: { id: string }) => p.id === "moneypal").active, true);
  });
});
