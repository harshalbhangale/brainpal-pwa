import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { mockToken } from "@brainpal/auth";
import { closePool, families, getDb, seedPalRegistry } from "@brainpal/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../dist/app.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
process.env["MOCK_AUTH"] = "true";

/** The Phase 2 acceptance demo, end to end through the HTTP API. */
describe("money: the chore loop", { skip: !hasDatabase }, () => {
  const db = getDb();
  let app: FastifyInstance;
  let familyId = "";
  const parent = mockToken(`test-${crypto.randomUUID()}`);
  const maya = mockToken(`test-${crypto.randomUUID()}`);
  let mayaId = "";
  let choreId = "";
  let approvalId = "";

  const call = (method: "GET" | "POST", url: string, token: string, body?: unknown, key?: string) =>
    app.inject({
      method,
      url,
      ...(body === undefined ? {} : { payload: body }),
      headers: {
        authorization: `Bearer ${token}`,
        ...(key ? { "idempotency-key": key } : {}),
      },
    });

  const command = (token: string, cmd: string, payload: unknown, key = crypto.randomUUID()) =>
    call("POST", "/v1/money/commands", token, { command: cmd, payload }, key);

  const wallet = async (token: string) => (await call("GET", "/v1/money/wallet", token)).json();

  before(async () => {
    await seedPalRegistry();
    app = await buildApp();
    await app.ready();

    const family = await call("POST", "/v1/onboarding/family", parent, {
      familyName: "MoneyTest",
      parentName: "Harshal",
      currency: "AUD",
    });
    familyId = family.json().familyId;

    const child = await call("POST", "/v1/families/current/children", parent, { displayName: "Maya" });
    mayaId = child.json().member.id;
    const joined = await call("POST", "/v1/join", maya, { code: child.json().joinCode });
    assert.equal(joined.statusCode, 200);
  });

  after(async () => {
    await app.close();
    await db.delete(families).where(eq(families.id, familyId));
    await closePool();
  });

  test("a parent tops up the family wallet", async () => {
    const res = await command(parent, "wallet.topup", { amountMinor: 20_00, title: "Pocket money float" });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((await wallet(parent)).familyWalletMinor, 20_00);
  });

  test("a money command without an idempotency key is refused", async () => {
    const res = await call("POST", "/v1/money/commands", parent, {
      command: "wallet.topup",
      payload: { amountMinor: 1_00, title: "x" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "IDEMPOTENCY_KEY_REQUIRED");
  });

  test("1. the parent creates a $5 chore for Maya", async () => {
    const res = await command(parent, "chore.assign", {
      childMemberId: mayaId,
      title: "Tidy your room",
      rewardMinor: 5_00,
      destination: "spend",
    });
    assert.equal(res.statusCode, 200, res.body);
    choreId = res.json().result.choreId;

    const mine = (await call("GET", "/v1/money/chores", maya)).json().chores;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, "open");
  });

  test("2. Maya submits it, and nothing is paid yet", async () => {
    const res = await command(maya, "chore.submit", { choreId });
    assert.equal(res.statusCode, 200, res.body);
    approvalId = res.json().result.approvalId;
    assert.ok(approvalId);

    const w = await wallet(parent);
    assert.equal(w.familyWalletMinor, 20_00, "no money moves on submission");
    assert.equal(w.children[0].spendMinor, 0);
  });

  test("3. the parent sees a pending approval with a server-written summary", async () => {
    const list = (await call("GET", "/v1/money/approvals", parent)).json().approvals;
    const card = list.find((a: { id: string }) => a.id === approvalId);
    assert.ok(card);
    assert.match(card.display.title, /Maya finished “Tidy your room”/);
    assert.equal(card.display.confirmLabel, "Approve & pay $5.00");
  });

  test("a child cannot approve their own chore", async () => {
    const res = await call("POST", `/v1/money/approvals/${approvalId}`, maya, { decision: "approve" });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "PARENT_ONLY");
  });

  test("4-5. the parent approves once, and a retry pays nothing more", async () => {
    const first = await call("POST", `/v1/money/approvals/${approvalId}`, parent, { decision: "approve" });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().replayed, false);

    const retry = await call("POST", `/v1/money/approvals/${approvalId}`, parent, { decision: "approve" });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().replayed, true);
    assert.equal(retry.json().result.transactionId, first.json().result.transactionId);

    const w = await wallet(parent);
    assert.equal(w.familyWalletMinor, 15_00);
    assert.equal(w.children[0].spendMinor, 5_00);
  });

  test("6. Maya sees her Spend balance — and only her own accounts", async () => {
    const w = await wallet(maya);
    assert.equal(w.familyWalletMinor, undefined, "a child never sees the family wallet");
    assert.equal(w.children.length, 1);
    assert.equal(w.children[0].spendMinor, 5_00);
  });

  test("7. a child trying to move money is blocked with a clear reason", async () => {
    const res = await command(maya, "money.transfer", {
      childMemberId: mayaId,
      destination: "spend",
      amountMinor: 10_00,
      title: "More please",
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "CHILD_CANNOT_MOVE_MONEY");
    assert.match(res.json().error.message, /Only a parent can move money/);
    assert.equal((await wallet(parent)).children[0].spendMinor, 5_00);
  });

  test("a retried command replays instead of running twice", async () => {
    const key = crypto.randomUUID();
    const payload = { childMemberId: mayaId, destination: "save", amountMinor: 2_00, title: "Bike fund" };
    const a = await command(parent, "money.transfer", payload, key);
    const b = await command(parent, "money.transfer", payload, key);
    assert.equal(a.json().commandId, b.json().commandId);
    assert.equal(b.json().replayed, true);
    assert.equal((await wallet(parent)).children[0].saveMinor, 2_00);
  });

  test("the same key with a different payload is refused", async () => {
    const key = crypto.randomUUID();
    await command(parent, "wallet.topup", { amountMinor: 1_00, title: "a" }, key);
    const res = await command(parent, "wallet.topup", { amountMinor: 9_00, title: "a" }, key);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
  });

  test("a transfer larger than the wallet fails and moves nothing", async () => {
    const before = await wallet(parent);
    const res = await command(parent, "money.transfer", {
      childMemberId: mayaId,
      destination: "spend",
      amountMinor: 999_00,
      title: "Too much",
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "INSUFFICIENT_FUNDS");
    assert.deepEqual(await wallet(parent), before);
  });

  test("a paid chore cannot be submitted again", async () => {
    const res = await command(maya, "chore.submit", { choreId });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "CHORE_NOT_SUBMITTABLE");
  });

  test("a parent can send a chore back for a redo, which pays nothing", async () => {
    const assigned = await command(parent, "chore.assign", {
      childMemberId: mayaId,
      title: "Feed the cat",
      rewardMinor: 1_00,
      destination: "spend",
    });
    const id = assigned.json().result.choreId;
    const submitted = await command(maya, "chore.submit", { choreId: id });
    const approval = submitted.json().result.approvalId;

    const spendBefore = (await wallet(parent)).children[0].spendMinor;
    const res = await call("POST", `/v1/money/approvals/${approval}`, parent, {
      decision: "reject",
      note: "The bowl is still empty",
    });
    assert.equal(res.statusCode, 200, res.body);

    const chore = (await call("GET", "/v1/money/chores", maya)).json().chores.find((c: { id: string }) => c.id === id);
    assert.equal(chore.status, "redo");
    assert.equal(chore.redoNote, "The bowl is still empty");
    assert.equal((await wallet(parent)).children[0].spendMinor, spendBefore);
  });
});
