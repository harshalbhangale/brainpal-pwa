import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { mockToken } from "@brainpal/auth";
import { closePool, families, getDb, seedPalRegistry } from "@brainpal/database";
import { SandboxCardProvider, setCardProvider } from "@brainpal/moneypal";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../dist/app.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
process.env["MOCK_AUTH"] = "true";

describe("money: requests, savings, cards, allowance, history", { skip: !hasDatabase }, () => {
  const db = getDb();
  let app: FastifyInstance;
  let familyId = "";
  const parent = mockToken(`test-${crypto.randomUUID()}`);
  const maya = mockToken(`test-${crypto.randomUUID()}`);
  let mayaId = "";
  let leoId = "";
  let topupTx = "";

  const call = (method: "GET" | "POST", url: string, token: string, body?: unknown) =>
    app.inject({
      method,
      url,
      ...(body === undefined ? {} : { payload: body }),
      headers: { authorization: `Bearer ${token}`, ...(method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}) },
    });
  const command = (token: string, cmd: string, payload: unknown) =>
    call("POST", "/v1/money/commands", token, { command: cmd, payload });
  const decide = (id: string, decision: "approve" | "reject") =>
    call("POST", `/v1/money/approvals/${id}`, parent, { decision });
  const mine = async () => (await call("GET", "/v1/money/wallet", maya)).json().children[0];

  before(async () => {
    await seedPalRegistry();
    app = await buildApp();
    await app.ready();
    familyId = (await call("POST", "/v1/onboarding/family", parent, { familyName: "More", parentName: "Harshal", currency: "AUD" })).json().familyId;
    const m = (await call("POST", "/v1/families/current/children", parent, { displayName: "Maya" })).json();
    mayaId = m.member.id;
    leoId = (await call("POST", "/v1/families/current/children", parent, { displayName: "Leo" })).json().member.id;
    await call("POST", "/v1/join", maya, { code: m.joinCode });
  });

  after(async () => {
    setCardProvider(new SandboxCardProvider());
    await app.close();
    await db.delete(families).where(eq(families.id, familyId));
    await closePool();
  });

  test("a child cannot ask to spend more than they have", async () => {
    const res = await command(maya, "spend.request", { amountMinor: 2_00, title: "Stickers" });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error.message, /You have \$0\.00 in Spend/);
  });

  test("setup: the parent funds the wallet and Maya's Spend", async () => {
    const top = await command(parent, "wallet.topup", { amountMinor: 50_00, title: "Float" });
    topupTx = top.json().result.transactionId;
    await command(parent, "money.transfer", { childMemberId: mayaId, destination: "spend", amountMinor: 10_00, title: "Pocket money" });
    assert.equal((await mine()).spendMinor, 10_00);
  });

  test("a spend request waits for a parent, then pays exactly once", async () => {
    const res = await command(maya, "spend.request", { amountMinor: 2_00, title: "Stickers", reason: "For my book" });
    assert.equal(res.statusCode, 200, res.body);
    const { approvalId } = res.json().result;
    assert.equal((await mine()).spendMinor, 10_00, "asking moves nothing");

    const card = (await call("GET", "/v1/money/approvals", parent)).json().approvals.find((a: { id: string }) => a.id === approvalId);
    assert.match(card.display.title, /Maya asks to spend \$2\.00/);

    assert.equal((await decide(approvalId, "approve")).statusCode, 200);
    assert.equal((await decide(approvalId, "approve")).json().replayed, true);
    assert.equal((await mine()).spendMinor, 8_00);
    const requests = (await call("GET", "/v1/money/requests", maya)).json().requests;
    assert.equal(requests[0].status, "approved");
  });

  test("a declined request moves nothing", async () => {
    const { approvalId } = (await command(maya, "spend.request", { amountMinor: 1_00, title: "Gum" })).json().result;
    assert.equal((await decide(approvalId, "reject")).statusCode, 200);
    assert.equal((await mine()).spendMinor, 8_00);
    const requests = (await call("GET", "/v1/money/requests", maya)).json().requests;
    assert.equal(requests.find((r: { title: string }) => r.title === "Gum").status, "declined");
  });

  test("a parent does not file spend requests", async () => {
    const res = await command(parent, "spend.request", { amountMinor: 1_00, title: "x" });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "CHILD_ONLY");
  });

  test("Maya can move her own money into Save straight away", async () => {
    const res = await command(maya, "savings.move", { childMemberId: mayaId, direction: "to_save", amountMinor: 3_00 });
    assert.equal(res.json().status, "executed");
    const w = await mine();
    assert.equal(w.spendMinor, 5_00);
    assert.equal(w.saveMinor, 3_00);
  });

  test("taking money out of Save needs a parent", async () => {
    const res = await command(maya, "savings.move", { childMemberId: mayaId, direction: "to_spend", amountMinor: 1_00 });
    assert.equal(res.json().status, "approval_pending");
    assert.equal((await mine()).saveMinor, 3_00, "nothing moves until a parent says so");
    assert.equal((await decide(res.json().result.approvalId, "approve")).statusCode, 200);
    const w = await mine();
    assert.equal(w.saveMinor, 2_00);
    assert.equal(w.spendMinor, 6_00);
  });

  test("Maya cannot move Leo's money", async () => {
    const res = await command(maya, "savings.move", { childMemberId: leoId, direction: "to_save", amountMinor: 1_00 });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "CROSS_MEMBER_FORBIDDEN");
  });

  test("a goal tracks the Save balance and works out a weekly path", async () => {
    const targetDate = new Date(Date.now() + 70 * 86_400_000).toISOString().slice(0, 10);
    const res = await command(maya, "savings.goal.create", { childMemberId: mayaId, title: "Bike", targetMinor: 50_00, targetDate });
    assert.equal(res.statusCode, 200, res.body);
    const [goal] = (await call("GET", "/v1/money/goals", maya)).json().goals;
    assert.equal(goal.savedMinor, 2_00);
    assert.equal(goal.weeklyPathMinor, 4_80);
  });

  test("only a parent can boost savings", async () => {
    assert.equal((await command(parent, "savings.boost", { childMemberId: mayaId, amountMinor: 1_00 })).statusCode, 200);
    assert.equal((await mine()).saveMinor, 3_00);
    const res = await command(maya, "savings.boost", { childMemberId: mayaId, amountMinor: 1_00 });
    assert.equal(res.json().error.code, "CHILD_CANNOT_MOVE_MONEY");
  });

  test("Maya can freeze her card but not unfreeze it", async () => {
    assert.equal((await command(maya, "card.freeze", { childMemberId: mayaId, frozen: true })).statusCode, 200);
    assert.equal((await call("GET", "/v1/money/cards", maya)).json().cards[0].frozen, true);
    const res = await command(maya, "card.freeze", { childMemberId: mayaId, frozen: false });
    assert.equal(res.json().error.code, "CHILD_CANNOT_UNFREEZE");
  });

  test("card controls are enforced when the money leaves", async () => {
    const { approvalId } = (await command(maya, "spend.request", { amountMinor: 1_00, title: "Comic" })).json().result;

    const frozen = await decide(approvalId, "approve");
    assert.equal(frozen.json().error.code, "CARD_FROZEN");

    await command(parent, "card.freeze", { childMemberId: mayaId, frozen: false });
    await command(parent, "card.limit", { childMemberId: mayaId, dailyLimitMinor: 50 });
    const limited = await decide(approvalId, "approve");
    assert.equal(limited.json().error.code, "DAILY_LIMIT_EXCEEDED");

    await command(parent, "card.limit", { childMemberId: mayaId, dailyLimitMinor: 50_00 });
    assert.equal((await decide(approvalId, "approve")).statusCode, 200);

    const res = await command(maya, "card.limit", { childMemberId: mayaId, dailyLimitMinor: 100_00 });
    assert.equal(res.json().error.code, "CHILD_CANNOT_MOVE_MONEY");
  });

  test("a provider failure changes nothing", async () => {
    setCardProvider({ name: "broken", apply: async () => ({ ok: false, error: "issuer down" }) });
    const res = await command(parent, "card.freeze", { childMemberId: mayaId, frozen: true });
    setCardProvider(new SandboxCardProvider());
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, "PROVIDER_FAILED");
    assert.equal((await call("GET", "/v1/money/cards", parent)).json().cards.find((c: { memberId: string }) => c.memberId === mayaId).frozen, false);
  });

  test("a parent sets and pauses an allowance; a child sees only their own", async () => {
    const set = await command(parent, "allowance.set", { childMemberId: mayaId, amountMinor: 10_00, weekday: 5, spendBasisPoints: 7000, timeZone: "Australia/Sydney" });
    assert.equal(set.statusCode, 200, set.body);
    assert.ok(new Date(set.json().result.nextRunAt) > new Date());

    const bad = await command(parent, "allowance.set", { childMemberId: leoId, amountMinor: 5_00, weekday: 1, spendBasisPoints: 5000, timeZone: "Mars/Olympus" });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "INVALID_TIMEZONE");

    await command(parent, "allowance.pause", { childMemberId: mayaId, paused: true });
    const list = (await call("GET", "/v1/money/allowances", maya)).json().allowances;
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "paused");
  });

  test("history shows a child only their own lines, and a receipt is private", async () => {
    const kid = (await call("GET", "/v1/money/history", maya)).json();
    assert.ok(kid.items.length > 0);
    for (const item of kid.items) {
      for (const line of item.lines) assert.equal(line.ownerMemberId, mayaId, "no family-wallet or sibling lines");
    }
    const stickers = kid.items.find((i: { title: string }) => i.title === "Stickers");
    assert.equal(stickers.netMinor, -2_00);

    const found = (await call("GET", "/v1/money/history?q=Stick", parent)).json().items;
    assert.ok(found.length >= 1);
    assert.ok(found.every((i: { title: string }) => /Stick/.test(i.title)));

    const topup = (await call("GET", "/v1/money/history?kind=topup", parent)).json().items[0];
    assert.equal(topup.netMinor, 50_00);

    assert.equal((await call("GET", `/v1/money/receipts/${topupTx}`, maya)).statusCode, 404);
    const receipt = await call("GET", `/v1/money/receipts/${topupTx}`, parent);
    assert.equal(receipt.statusCode, 200);
    assert.match(receipt.json().receiptNumber, /^BP-[0-9A-F]{8}$/);
  });

  test("a parent can reverse a transaction once, and a reversal cannot be reversed", async () => {
    const sent = await command(parent, "money.transfer", { childMemberId: mayaId, destination: "save", amountMinor: 1_00, title: "Oops" });
    const tx = sent.json().result.transactionId;
    const before = (await mine()).saveMinor;

    const rev = await command(parent, "money.reverse", { transactionId: tx, reason: "Sent by mistake" });
    assert.equal(rev.statusCode, 200, rev.body);
    assert.equal((await mine()).saveMinor, before - 1_00);

    const again = await command(parent, "money.reverse", { transactionId: tx, reason: "again" });
    assert.equal(again.json().error.code, "ALREADY_REVERSED");

    const original = (await call("GET", `/v1/money/receipts/${tx}`, parent)).json();
    assert.equal(original.status, "reversed");
    assert.equal(original.reversedByTransactionId, rev.json().result.transactionId);

    const reversal = (await call("GET", `/v1/money/receipts/${rev.json().result.transactionId}`, parent)).json();
    assert.equal(reversal.reversesTransactionId, tx);
    assert.equal(reversal.reason, "Sent by mistake");

    const back = await command(parent, "money.reverse", { transactionId: rev.json().result.transactionId, reason: "undo" });
    assert.equal(back.json().error.code, "REVERSAL_NOT_ALLOWED");
  });

  test("money that has already been spent cannot be reversed", async () => {
    // $10 was sent to Maya's Spend, but she has since spent and moved some of it.
    const pocket = (await call("GET", "/v1/money/history?q=Pocket", parent)).json().items[0];
    const res = await command(parent, "money.reverse", { transactionId: pocket.transactionId, reason: "test" });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "REVERSAL_INSUFFICIENT_FUNDS");
  });

  test("a child cannot reverse anything", async () => {
    const res = await command(maya, "money.reverse", { transactionId: topupTx, reason: "mine now" });
    assert.equal(res.json().error.code, "CHILD_CANNOT_MOVE_MONEY");
  });

  test("a family is created in its own time zone, and a bad one is refused", async () => {
    const res = await call("POST", "/v1/onboarding/family", mockToken(`test-${crypto.randomUUID()}`), {
      familyName: "Nowhere",
      parentName: "P",
      currency: "AUD",
      timeZone: "Mars/Olympus",
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "INVALID_TIMEZONE");
  });
});
