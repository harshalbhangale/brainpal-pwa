import { type Database, moneyAccounts } from "@brainpal/database";
import { and, eq, isNull } from "drizzle-orm";

import { MoneyError } from "./errors.js";
import type { Tx } from "./ledger.js";

type Executor = Tx | Database;
type Purpose = (typeof moneyAccounts.$inferSelect)["purpose"];

export async function openFamilyAccounts(tx: Executor, familyId: string): Promise<void> {
  await tx
    .insert(moneyAccounts)
    .values([
      { familyId, purpose: "family_wallet" },
      { familyId, purpose: "external_funding" },
    ])
    .onConflictDoNothing();
}

export async function openMemberAccounts(
  tx: Executor,
  familyId: string,
  memberId: string,
): Promise<void> {
  await tx
    .insert(moneyAccounts)
    .values([
      { familyId, ownerMemberId: memberId, purpose: "spend" },
      { familyId, ownerMemberId: memberId, purpose: "save" },
    ])
    .onConflictDoNothing();
}

export async function accountId(
  tx: Executor,
  familyId: string,
  purpose: Purpose,
  ownerMemberId: string | null = null,
): Promise<string> {
  const [row] = await tx
    .select({ id: moneyAccounts.id })
    .from(moneyAccounts)
    .where(
      and(
        eq(moneyAccounts.familyId, familyId),
        eq(moneyAccounts.purpose, purpose),
        eq(moneyAccounts.status, "active"),
        ownerMemberId === null
          ? isNull(moneyAccounts.ownerMemberId)
          : eq(moneyAccounts.ownerMemberId, ownerMemberId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new MoneyError("ACCOUNT_NOT_FOUND", `no active ${purpose} account`);
  }
  return row.id;
}
