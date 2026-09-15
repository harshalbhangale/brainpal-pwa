import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  closePool,
  families,
  familyMembers,
  getDb,
  getPool,
  ledgerEntries,
  ledgerTransactions,
} from "@brainpal/database";
import { eq } from "drizzle-orm";

import {
  MoneyError,
  accountId,
  balanceMinor,
  canonicalJson,
  openFamilyAccounts,
  openMemberAccounts,
  postTransaction,
} from "../dist/index.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);

function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof MoneyError, `expected MoneyError, got ${String(error)}`);
    assert.equal(error.code, expected);
    return true;
  };
}

test("canonical JSON ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
});

describe("ledger", { skip: !hasDatabase }, () => {
  const db = getDb();
  let familyId = "";
  let otherFamilyId = "";
  let wallet = "";
  let funding = "";
  let mayaSpend = "";
  let mayaSave = "";
  let otherWallet = "";

  const key = () => `test:${crypto.randomUUID()}`;
  const topUp = (amountMinor: number, idempotencyKey = key()) =>
    db.transaction((tx) =>
      postTransaction(tx, {
        familyId,
        kind: "topup",
        idempotencyKey,
        postings: [
          { accountId: funding, direction: "debit", amountMinor },
          { accountId: wallet, direction: "credit", amountMinor },
        ],
      }),
    );

  before(async () => {
    const [family] = await db.insert(families).values({ name: "LedgerTest" }).returning();
    const [other] = await db.insert(families).values({ name: "LedgerOther" }).returning();
    familyId = family!.id;
    otherFamilyId = other!.id;
    const [maya] = await db
      .insert(familyMembers)
      .values({ familyId, role: "child", displayName: "Maya", status: "active" })
      .returning();

    await db.transaction(async (tx) => {
      await openFamilyAccounts(tx, familyId);
      await openMemberAccounts(tx, familyId, maya!.id);
      await openFamilyAccounts(tx, otherFamilyId);
      wallet = await accountId(tx, familyId, "family_wallet");
      funding = await accountId(tx, familyId, "external_funding");
      mayaSpend = await accountId(tx, familyId, "spend", maya!.id);
      mayaSave = await accountId(tx, familyId, "save", maya!.id);
      otherWallet = await accountId(tx, otherFamilyId, "family_wallet");
    });
  });

  after(async () => {
    await db.delete(families).where(eq(families.id, familyId));
    await db.delete(families).where(eq(families.id, otherFamilyId));
    await closePool();
  });

  test("a balanced top-up moves money and nothing else", async () => {
    await topUp(10_00);
    assert.equal(await balanceMinor(db, wallet), 10_00);
    assert.equal(await balanceMinor(db, funding), -10_00);
  });

  test("unbalanced postings are refused before touching the database", async () => {
    await assert.rejects(
      db.transaction((tx) =>
        postTransaction(tx, {
          familyId,
          kind: "bad",
          idempotencyKey: key(),
          postings: [
            { accountId: funding, direction: "debit", amountMinor: 5_00 },
            { accountId: wallet, direction: "credit", amountMinor: 4_00 },
          ],
        }),
      ),
      code("LEDGER_UNBALANCED"),
    );
  });

  test("the database itself rejects an unbalanced transaction at commit", async () => {
    // Bypasses the TypeScript check entirely: the deferred trigger is the last line of defence.
    await assert.rejects(
      db.transaction(async (tx) => {
        const [t] = await tx
          .insert(ledgerTransactions)
          .values({ familyId, kind: "raw", idempotencyKey: key() })
          .returning();
        await tx.insert(ledgerEntries).values({ transactionId: t!.id, accountId: wallet, direction: "credit", amountMinor: 1_00 });
      }),
      (error: unknown) => /unbalanced ledger transaction/.test(String((error as { cause?: unknown }).cause ?? error)),
    );
  });

  test("an entry cannot land on another family's account", async () => {
    await assert.rejects(
      db.transaction(async (tx) => {
        const [t] = await tx
          .insert(ledgerTransactions)
          .values({ familyId, kind: "raw", idempotencyKey: key() })
          .returning();
        await tx.insert(ledgerEntries).values([
          { transactionId: t!.id, accountId: funding, direction: "debit", amountMinor: 1_00 },
          { transactionId: t!.id, accountId: otherWallet, direction: "credit", amountMinor: 1_00 },
        ]);
      }),
      (error: unknown) => /family mismatch/.test(String((error as { cause?: unknown }).cause ?? error)),
    );
  });

  test("a child account cannot go below zero", async () => {
    await assert.rejects(
      db.transaction((tx) =>
        postTransaction(tx, {
          familyId,
          kind: "move",
          idempotencyKey: key(),
          postings: [
            { accountId: mayaSpend, direction: "debit", amountMinor: 1_00 },
            { accountId: mayaSave, direction: "credit", amountMinor: 1_00 },
          ],
        }),
      ),
      code("INSUFFICIENT_FUNDS"),
    );
  });

  test("a retry replays the original success, even after the money has moved on", async () => {
    const sendKey = key();
    const send = () =>
      db.transaction((tx) =>
        postTransaction(tx, {
          familyId,
          kind: "send",
          idempotencyKey: sendKey,
          postings: [
            { accountId: wallet, direction: "debit", amountMinor: 3_00 },
            { accountId: mayaSpend, direction: "credit", amountMinor: 3_00 },
          ],
        }),
      );

    const first = await send();
    assert.equal(first.replayed, false);

    // Maya spends it all, so a naive retry would now fail the funds check.
    await db.transaction((tx) =>
      postTransaction(tx, {
        familyId,
        kind: "spend",
        idempotencyKey: key(),
        postings: [
          { accountId: mayaSpend, direction: "debit", amountMinor: 3_00 },
          { accountId: funding, direction: "credit", amountMinor: 3_00 },
        ],
      }),
    );

    const retry = await send();
    assert.equal(retry.replayed, true);
    assert.equal(retry.transactionId, first.transactionId);
    assert.equal(await balanceMinor(db, mayaSpend), 0);
  });

  test("two concurrent submissions with one key post exactly once", async () => {
    const before = await balanceMinor(db, wallet);
    const shared = key();
    const results = await Promise.allSettled([topUp(2_00, shared), topUp(2_00, shared)]);

    const ok = results.filter((r) => r.status === "fulfilled");
    assert.ok(ok.length >= 1);
    assert.equal(await balanceMinor(db, wallet), before + 2_00);

    const rows = await db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, shared));
    assert.equal(rows.length, 1);
  });

  test("a key reused for a different kind of transaction is refused", async () => {
    const reused = key();
    await topUp(1_00, reused);
    await assert.rejects(
      db.transaction((tx) =>
        postTransaction(tx, {
          familyId,
          kind: "send",
          idempotencyKey: reused,
          postings: [
            { accountId: wallet, direction: "debit", amountMinor: 1_00 },
            { accountId: mayaSpend, direction: "credit", amountMinor: 1_00 },
          ],
        }),
      ),
      code("IDEMPOTENCY_CONFLICT"),
    );
  });

  test("pool is reachable", async () => {
    assert.ok(getPool());
  });
});
