import type { Database } from "@brainpal/database";

import { type Actor, choresFor, pendingApprovals, walletFor } from "./engine.js";
import { isParentRole } from "./policy.js";

const aud = (minor: number) => `$${(minor / 100).toFixed(2)}`;

const CHORE_STATE: Record<string, string> = {
  open: "not done yet",
  submitted: "submitted, waiting for a parent to approve before it is paid",
  redo: "sent back for another go",
};

/**
 * The only family numbers MoneyPAL may state, read from the ledger and scoped
 * exactly as the wallet screen is: a child's facts never include the family
 * wallet or a sibling.
 */
export async function ledgerFacts(db: Database, actor: Actor): Promise<string> {
  const [wallet, chores] = await Promise.all([walletFor(db, actor), choresFor(db, actor)]);
  const lines: string[] = [];

  if (wallet.familyWalletMinor !== undefined) {
    lines.push(`Family wallet: ${aud(wallet.familyWalletMinor)}.`);
  }
  for (const child of wallet.children) {
    lines.push(`${child.displayName}: Spend ${aud(child.spendMinor)}, Save ${aud(child.saveMinor)}.`);
  }

  const names = new Map(wallet.children.map((c) => [c.memberId, c.displayName]));
  for (const chore of chores) {
    const state = CHORE_STATE[chore.status];
    if (!state) continue;
    lines.push(
      `Chore "${chore.title}" for ${names.get(chore.assignedMemberId) ?? "a child"}: ` +
        `${aud(chore.rewardMinor)} to ${chore.destination === "save" ? "Save" : "Spend"}, ${state}.`,
    );
  }

  if (isParentRole(actor.role)) {
    const pending = await pendingApprovals(db, actor);
    lines.push(
      pending.length === 0
        ? "No approvals are waiting."
        : `${pending.length} approval${pending.length === 1 ? " is" : "s are"} waiting for a parent.`,
    );
  }

  return lines.length > 0 ? lines.join("\n") : "This family has no money set up yet.";
}
