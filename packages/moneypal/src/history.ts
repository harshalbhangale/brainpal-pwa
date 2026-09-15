import {
  type Database,
  allowanceRuns,
  allowanceSchedules,
  familyMembers,
  ledgerEntries,
  ledgerTransactions,
  moneyAccounts,
  spendRequests,
} from "@brainpal/database";
import { and, desc, eq, ilike, inArray, isNotNull, sql } from "drizzle-orm";

import { type Actor, visibleChildren } from "./engine.js";
import { MoneyError } from "./errors.js";
import { isParentRole } from "./policy.js";

const KIND_LABEL: Record<string, string> = {
  topup: "Top-up",
  transfer: "Money sent",
  chore: "Chore reward",
  allowance: "Allowance",
  spend: "Spent",
  savings_move: "Savings move",
  boost: "Savings boost",
  reversal: "Reversal",
};

export interface HistoryLine {
  account: string;
  purpose: string;
  ownerMemberId: string | null;
  direction: "debit" | "credit";
  amountMinor: number;
}

export interface HistoryItem {
  transactionId: string;
  kind: string;
  title: string;
  createdAt: string;
  /** "reversed" once a later reversal has undone it. The original is never edited. */
  status: "settled" | "reversed";
  /** The amount the transaction moved. */
  amountMinor: number;
  /** The change to the accounts the viewer can see: in is positive, out negative. Top-up sources are not counted. */
  netMinor: number;
  lines: HistoryLine[];
  reversedByTransactionId: string | null;
  reversesTransactionId: string | null;
}

export interface HistoryOptions {
  kind?: string | undefined;
  q?: string | undefined;
  memberId?: string | undefined;
  limit?: number | undefined;
}

type TxRow = {
  id: string;
  kind: string;
  createdAt: Date;
  metadata: unknown;
  reversesTransactionId: string | null;
};

const txColumns = {
  id: ledgerTransactions.id,
  kind: ledgerTransactions.kind,
  createdAt: ledgerTransactions.createdAt,
  metadata: ledgerTransactions.metadata,
  reversesTransactionId: ledgerTransactions.reversesTransactionId,
};

async function visibleAccounts(db: Database, actor: Actor, memberId?: string) {
  return db
    .select({ id: moneyAccounts.id })
    .from(moneyAccounts)
    .where(
      and(
        eq(moneyAccounts.familyId, actor.familyId),
        ...(isParentRole(actor.role) ? [] : [eq(moneyAccounts.ownerMemberId, actor.memberId)]),
        ...(memberId ? [eq(moneyAccounts.ownerMemberId, memberId)] : []),
      ),
    );
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function build(db: Database, actor: Actor, rows: TxRow[], visibleIds: Set<string>): Promise<HistoryItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const entries = await db
    .select({
      transactionId: ledgerEntries.transactionId,
      accountId: ledgerEntries.accountId,
      direction: ledgerEntries.direction,
      amountMinor: ledgerEntries.amountMinor,
      purpose: moneyAccounts.purpose,
      owner: moneyAccounts.ownerMemberId,
    })
    .from(ledgerEntries)
    .innerJoin(moneyAccounts, eq(moneyAccounts.id, ledgerEntries.accountId))
    .where(inArray(ledgerEntries.transactionId, ids));

  const reversals = await db
    .select({ id: ledgerTransactions.id, reverses: ledgerTransactions.reversesTransactionId })
    .from(ledgerTransactions)
    .where(and(isNotNull(ledgerTransactions.reversesTransactionId), inArray(ledgerTransactions.reversesTransactionId, ids)));
  const reversedBy = new Map(reversals.map((r) => [r.reverses, r.id]));

  const members = await db
    .select({ id: familyMembers.id, displayName: familyMembers.displayName })
    .from(familyMembers)
    .where(eq(familyMembers.familyId, actor.familyId));
  const names = new Map(members.map((m) => [m.id, m.displayName]));

  const label = (purpose: string, owner: string | null) => {
    if (purpose === "family_wallet") return "Family wallet";
    if (purpose === "external_funding") return "Outside BrainPal";
    return `${(owner && names.get(owner)) || "Child"} · ${purpose === "save" ? "Save" : "Spend"}`;
  };

  return rows.map((row) => {
    const all = entries.filter((e) => e.transactionId === row.id);
    const shown = all.filter((e) => visibleIds.has(e.accountId));
    const title = (row.metadata as { title?: unknown } | null)?.title;
    const reversal = reversedBy.get(row.id) ?? null;
    return {
      transactionId: row.id,
      kind: row.kind,
      title: typeof title === "string" ? title : (KIND_LABEL[row.kind] ?? row.kind),
      createdAt: row.createdAt.toISOString(),
      status: reversal ? ("reversed" as const) : ("settled" as const),
      amountMinor: all.filter((e) => e.direction === "debit").reduce((sum, e) => sum + e.amountMinor, 0),
      netMinor: shown
        .filter((e) => e.purpose !== "external_funding")
        .reduce((sum, e) => sum + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0),
      lines: shown.map((e) => ({
        account: label(e.purpose, e.owner),
        purpose: e.purpose,
        ownerMemberId: e.owner,
        direction: e.direction,
        amountMinor: e.amountMinor,
      })),
      reversedByTransactionId: reversal,
      reversesTransactionId: row.reversesTransactionId,
    };
  });
}

/**
 * Settled ledger history plus what is still pending or has failed. A child
 * only ever sees transactions that touch their own accounts, and only their
 * own lines within them.
 */
export async function historyFor(db: Database, actor: Actor, opts: HistoryOptions = {}) {
  const accounts = await visibleAccounts(db, actor, opts.memberId);
  const ids = accounts.map((a) => a.id);

  const rows =
    ids.length === 0
      ? []
      : await db
          .selectDistinct(txColumns)
          .from(ledgerTransactions)
          .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
          .where(
            and(
              eq(ledgerTransactions.familyId, actor.familyId),
              inArray(ledgerEntries.accountId, ids),
              ...(opts.kind ? [eq(ledgerTransactions.kind, opts.kind)] : []),
              ...(opts.q
                ? [ilike(sql`${ledgerTransactions.metadata}->>'title'`, `%${escapeLike(opts.q)}%`)]
                : []),
            ),
          )
          .orderBy(desc(ledgerTransactions.createdAt))
          .limit(Math.min(opts.limit ?? 50, 200));

  const items = await build(db, actor, rows, new Set(ids));

  const kids = (await visibleChildren(db, actor)).filter((k) => !opts.memberId || k.id === opts.memberId);
  const kidIds = kids.map((k) => k.id);

  const pending =
    kidIds.length === 0
      ? []
      : await db
          .select({
            requestId: spendRequests.id,
            memberId: spendRequests.requesterMemberId,
            title: spendRequests.title,
            amountMinor: spendRequests.amountMinor,
            createdAt: spendRequests.createdAt,
          })
          .from(spendRequests)
          .where(and(inArray(spendRequests.requesterMemberId, kidIds), eq(spendRequests.status, "pending")))
          .orderBy(desc(spendRequests.createdAt));

  const failed =
    kidIds.length === 0
      ? []
      : await db
          .select({
            periodKey: allowanceRuns.periodKey,
            memberId: allowanceSchedules.childMemberId,
            amountMinor: allowanceRuns.amountMinor,
            errorCode: allowanceRuns.errorCode,
            attempts: allowanceRuns.attempts,
          })
          .from(allowanceRuns)
          .innerJoin(allowanceSchedules, eq(allowanceSchedules.id, allowanceRuns.scheduleId))
          .where(and(inArray(allowanceSchedules.childMemberId, kidIds), eq(allowanceRuns.status, "failed")))
          .orderBy(desc(allowanceRuns.updatedAt));

  return { items, pending, failed };
}

export async function receiptFor(db: Database, actor: Actor, transactionId: string) {
  const accounts = await visibleAccounts(db, actor);
  const ids = accounts.map((a) => a.id);
  const [row] =
    ids.length === 0
      ? []
      : await db
          .selectDistinct(txColumns)
          .from(ledgerTransactions)
          .innerJoin(ledgerEntries, eq(ledgerEntries.transactionId, ledgerTransactions.id))
          .where(
            and(
              eq(ledgerTransactions.id, transactionId),
              eq(ledgerTransactions.familyId, actor.familyId),
              inArray(ledgerEntries.accountId, ids),
            ),
          )
          .limit(1);
  // Not found and not visible are the same answer, so receipt ids cannot be probed.
  if (!row) throw new MoneyError("TRANSACTION_NOT_FOUND", "that receipt was not found");
  const [item] = await build(db, actor, [row], new Set(ids));
  const reason = (row.metadata as { reason?: unknown } | null)?.reason;
  return {
    ...item!,
    receiptNumber: `BP-${transactionId.slice(0, 8).toUpperCase()}`,
    reason: typeof reason === "string" ? reason : null,
  };
}
