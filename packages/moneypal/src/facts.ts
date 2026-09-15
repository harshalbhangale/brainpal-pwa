import type { Database } from "@brainpal/database";

import {
  type Actor,
  allowancesFor,
  cardsFor,
  choresFor,
  goalsFor,
  pendingApprovals,
  requestsFor,
  walletFor,
} from "./engine.js";
import { isParentRole } from "./policy.js";

const aud = (minor: number) => `$${(minor / 100).toFixed(2)}`;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CHORE_STATE: Record<string, string> = {
  open: "not done yet",
  submitted: "submitted, waiting for a parent to approve before it is paid",
  redo: "sent back for another go",
};

/**
 * The only family numbers MoneyPAL may state, read from the ledger and scoped
 * exactly as the Money screen is: a child's facts never include the family
 * wallet, a sibling or the approval queue.
 */
export async function ledgerFacts(db: Database, actor: Actor): Promise<string> {
  const [wallet, chores, goals, allowances, cards, requests] = await Promise.all([
    walletFor(db, actor),
    choresFor(db, actor),
    goalsFor(db, actor),
    allowancesFor(db, actor),
    cardsFor(db, actor),
    requestsFor(db, actor),
  ]);
  const names = new Map(wallet.children.map((c) => [c.memberId, c.displayName]));
  const who = (id: string) => names.get(id) ?? "a child";
  const lines: string[] = [];

  if (wallet.familyWalletMinor !== undefined) {
    lines.push(`Family wallet: ${aud(wallet.familyWalletMinor)}.`);
  }
  for (const child of wallet.children) {
    lines.push(`${child.displayName}: Spend ${aud(child.spendMinor)}, Save ${aud(child.saveMinor)}.`);
  }

  for (const chore of chores) {
    const state = CHORE_STATE[chore.status];
    if (!state) continue;
    lines.push(
      `Chore "${chore.title}" for ${who(chore.assignedMemberId)}: ` +
        `${aud(chore.rewardMinor)} to ${chore.destination === "save" ? "Save" : "Spend"}, ${state}.`,
    );
  }

  for (const goal of goals) {
    const path =
      goal.achieved
        ? " — reached"
        : goal.weeklyPathMinor !== null && goal.targetDate
          ? `; about ${aud(goal.weeklyPathMinor)} a week reaches it by ${goal.targetDate}`
          : "";
    lines.push(
      `Savings goal "${goal.title}" for ${goal.ownerName}: ${aud(goal.savedMinor)} of ${aud(goal.targetMinor)} in Save${path}.`,
    );
  }

  for (const a of allowances) {
    const spendPercent = Math.round(a.spendBasisPoints / 100);
    let line =
      `${a.childName}'s allowance: ${aud(a.amountMinor)} every ${WEEKDAYS[a.weekday]}, ` +
      `${spendPercent}% to Spend and ${100 - spendPercent}% to Save` +
      (a.status === "paused" ? " (paused)." : ".");
    if (a.lastRun?.status === "failed") {
      line += ` The payment for ${a.lastRun.periodKey} failed because the family wallet did not have enough, and will be retried.`;
    }
    lines.push(line);
  }

  for (const card of cards) {
    lines.push(
      `${card.displayName}'s card is ${card.frozen ? "frozen" : "active"}, with a ${aud(card.dailyLimitMinor)} daily limit.`,
    );
  }

  for (const request of requests) {
    if (request.status !== "pending") continue;
    lines.push(
      `${who(request.requesterMemberId)} asked to spend ${aud(request.amountMinor)} on "${request.title}" — waiting for a parent.`,
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
