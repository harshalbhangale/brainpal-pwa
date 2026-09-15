import {
  type Database,
  ledgerEntries,
  ledgerTransactions,
  moneyAccounts,
} from "@brainpal/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { MoneyError } from "./errors.js";

/** Posting takes a transaction, not a pool: the row locks mean nothing outside one. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface Posting {
  accountId: string;
  direction: "debit" | "credit";
  amountMinor: number;
}

export interface PostInput {
  familyId: string;
  kind: string;
  idempotencyKey: string;
  postings: Posting[];
  commandId?: string;
  actorMemberId?: string | null;
  metadata?: Record<string, unknown>;
  reversesTransactionId?: string;
}

export interface PostResult {
  transactionId: string;
  replayed: boolean;
}

const MAX_AMOUNT_MINOR = 1_000_000_00;

function assertBalanced(postings: Posting[]): void {
  if (postings.length < 2) {
    throw new MoneyError("LEDGER_POSTINGS_INVALID", "at least two postings are required");
  }
  let debits = 0;
  let credits = 0;
  for (const p of postings) {
    if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0 || p.amountMinor > MAX_AMOUNT_MINOR) {
      throw new MoneyError("LEDGER_AMOUNT_INVALID", "postings need positive integer minor units");
    }
    if (p.direction === "debit") debits += p.amountMinor;
    else credits += p.amountMinor;
  }
  if (debits !== credits) {
    throw new MoneyError("LEDGER_UNBALANCED", "debits and credits must balance");
  }
}

export async function balanceMinor(tx: Tx | Database, accountId: string): Promise<number> {
  const [row] = await tx
    .select({
      minor: sql<string>`coalesce(sum(case when ${ledgerEntries.direction} = 'credit' then ${ledgerEntries.amountMinor} else -${ledgerEntries.amountMinor} end), 0)`,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.accountId, accountId));
  return Number(row?.minor ?? 0);
}

/**
 * Posts one balanced transaction, exactly once per idempotency key.
 *
 * Accounts are locked in id order so two concurrent postings over the same
 * accounts cannot deadlock. The replay check runs before the funds check: a
 * retry of a transaction that already succeeded must return that success, not
 * fail because the money it moved has since been spent.
 */
export async function postTransaction(tx: Tx, input: PostInput): Promise<PostResult> {
  assertBalanced(input.postings);

  const ids = [...new Set(input.postings.map((p) => p.accountId))];
  const accounts = await tx
    .select({ id: moneyAccounts.id, purpose: moneyAccounts.purpose })
    .from(moneyAccounts)
    .where(
      and(
        inArray(moneyAccounts.id, ids),
        eq(moneyAccounts.familyId, input.familyId),
        eq(moneyAccounts.status, "active"),
      ),
    )
    .orderBy(asc(moneyAccounts.id))
    .for("update");
  if (accounts.length !== ids.length) {
    throw new MoneyError("ACCOUNT_NOT_FOUND", "one or more accounts are unavailable");
  }

  const [existing] = await tx
    .select({ id: ledgerTransactions.id, familyId: ledgerTransactions.familyId, kind: ledgerTransactions.kind })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing) {
    if (existing.familyId !== input.familyId || existing.kind !== input.kind) {
      throw new MoneyError("IDEMPOTENCY_CONFLICT", "idempotency key was used for a different transaction");
    }
    return { transactionId: existing.id, replayed: true };
  }

  const purposeOf = new Map(accounts.map((a) => [a.id, a.purpose]));
  const debitTotals = new Map<string, number>();
  for (const p of input.postings) {
    if (p.direction === "debit") {
      debitTotals.set(p.accountId, (debitTotals.get(p.accountId) ?? 0) + p.amountMinor);
    }
  }
  for (const [id, required] of debitTotals) {
    if (purposeOf.get(id) === "external_funding") continue;
    const available = await balanceMinor(tx, id);
    if (available < required) {
      throw new MoneyError("INSUFFICIENT_FUNDS", "the source account does not have enough money", {
        accountId: id,
        availableMinor: available,
        requiredMinor: required,
      });
    }
  }

  const [created] = await tx
    .insert(ledgerTransactions)
    .values({
      familyId: input.familyId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      commandId: input.commandId ?? null,
      createdByMemberId: input.actorMemberId ?? null,
      metadata: input.metadata ?? null,
      reversesTransactionId: input.reversesTransactionId ?? null,
    })
    .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
    .returning({ id: ledgerTransactions.id });

  if (!created) {
    // A concurrent posting with the same key committed between our check and insert.
    const [raced] = await tx
      .select({ id: ledgerTransactions.id, familyId: ledgerTransactions.familyId })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!raced || raced.familyId !== input.familyId) {
      throw new MoneyError("IDEMPOTENCY_CONFLICT", "idempotency key conflict");
    }
    return { transactionId: raced.id, replayed: true };
  }

  await tx.insert(ledgerEntries).values(
    input.postings.map((p) => ({
      transactionId: created.id,
      accountId: p.accountId,
      direction: p.direction,
      amountMinor: p.amountMinor,
    })),
  );

  return { transactionId: created.id, replayed: false };
}
