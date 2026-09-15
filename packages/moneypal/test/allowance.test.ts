import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  allowanceRuns,
  allowanceSchedules,
  closePool,
  families,
  familyMembers,
  getDb,
  ledgerTransactions,
} from "@brainpal/database";
import { and, eq } from "drizzle-orm";

import { recordProviderEvent, runDueAllowances, submitCommand, walletFor } from "../dist/index.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);

// Friday 18 Sep 2026, 7am Sydney, and an hour after it.
const PERIOD_AT = new Date("2026-09-17T21:00:00Z");
const NOW = new Date("2026-09-17T22:00:00Z");

describe("allowance scheduler", { skip: !hasDatabase }, () => {
  const db = getDb();
  let familyId = "";
  let parentId = "";
  let mayaId = "";
  const parent = () => ({ memberId: parentId, familyId, role: "parent" as const });
  const run = (now: Date) => runDueAllowances(db, { now, familyId });

  const rewind = () =>
    db
      .update(allowanceSchedules)
      .set({ nextRunAt: PERIOD_AT, retryAt: null })
      .where(eq(allowanceSchedules.childMemberId, mayaId));

  before(async () => {
    const [family] = await db.insert(families).values({ name: "AllowanceTest" }).returning();
    familyId = family!.id;
    const [p] = await db
      .insert(familyMembers)
      .values({ familyId, role: "parent", displayName: "Parent", status: "active" })
      .returning();
    const [m] = await db
      .insert(familyMembers)
      .values({ familyId, role: "child", displayName: "Maya", status: "active" })
      .returning();
    parentId = p!.id;
    mayaId = m!.id;

    await submitCommand(
      db,
      parent(),
      {
        command: "allowance.set",
        payload: { childMemberId: mayaId, amountMinor: 10_00, weekday: 5, spendBasisPoints: 7000, timeZone: "Australia/Sydney" },
      },
      crypto.randomUUID(),
    );
    await rewind();
  });

  after(async () => {
    await db.delete(families).where(eq(families.id, familyId));
    await closePool();
  });

  test("an unfunded allowance is recorded as failed and pays nothing", async () => {
    const [report] = await run(NOW);
    assert.equal(report?.outcome, "failed");
    assert.equal(report?.code, "INSUFFICIENT_FUNDS");

    const runs = await db.select().from(allowanceRuns).where(eq(allowanceRuns.familyId, familyId));
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "failed");
    assert.equal(runs[0]!.periodKey, "2026-09-18");

    const paid = await db
      .select()
      .from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.familyId, familyId), eq(ledgerTransactions.kind, "allowance")));
    assert.equal(paid.length, 0, "a failure never writes money");
  });

  test("a failed run waits out its back-off before retrying", async () => {
    assert.deepEqual(await run(NOW), []);
  });

  test("once the wallet is funded, the retry pays the same week, split 70/30", async () => {
    await submitCommand(db, parent(), { command: "wallet.topup", payload: { amountMinor: 50_00, title: "Float" } }, crypto.randomUUID());
    const [report] = await run(new Date(NOW.getTime() + 2 * 3600_000));
    assert.equal(report?.outcome, "paid");
    assert.equal(report?.periodKey, "2026-09-18");

    const wallet = await walletFor(db, parent());
    assert.equal(wallet.familyWalletMinor, 40_00);
    assert.equal(wallet.children[0]!.spendMinor, 7_00);
    assert.equal(wallet.children[0]!.saveMinor, 3_00);

    const [schedule] = await db.select().from(allowanceSchedules).where(eq(allowanceSchedules.childMemberId, mayaId));
    assert.equal(schedule!.nextRunAt.toISOString(), "2026-09-24T21:00:00.000Z", "moves on to the next Friday");
    const [row] = await db.select().from(allowanceRuns).where(eq(allowanceRuns.scheduleId, schedule!.id));
    assert.equal(row!.status, "succeeded");
  });

  test("the same week can never pay twice", async () => {
    await rewind();
    const [report] = await run(NOW);
    assert.equal(report?.outcome, "already_paid");
    const wallet = await walletFor(db, parent());
    assert.equal(wallet.children[0]!.spendMinor, 7_00);
    assert.equal(wallet.familyWalletMinor, 40_00);
  });

  test("a paused allowance does not run", async () => {
    await submitCommand(db, parent(), { command: "allowance.pause", payload: { childMemberId: mayaId, paused: true } }, crypto.randomUUID());
    await rewind();
    assert.deepEqual(await run(new Date("2030-01-01T00:00:00Z")), []);
  });

  test("a redelivered provider event is recorded once", async () => {
    const eventId = `evt-${crypto.randomUUID()}`;
    const first = await recordProviderEvent(db, { provider: "sandbox", eventId, type: "card.updated", familyId });
    const again = await recordProviderEvent(db, { provider: "sandbox", eventId, type: "card.updated", familyId });
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
  });
});
