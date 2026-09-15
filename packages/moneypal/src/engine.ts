import { type MoneyCommand, SavingsMove } from "@brainpal/contracts";
import {
  type CommandDisplay,
  type Database,
  allowanceRuns,
  allowanceSchedules,
  approvals,
  auditEvents,
  cardControls,
  chores,
  familyMembers,
  ledgerEntries,
  ledgerTransactions,
  moneyAccounts,
  moneyCommands,
  savingsGoals,
  spendRequests,
} from "@brainpal/database";
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";

import { accountId, openFamilyAccounts, openMemberAccounts } from "./accounts.js";
import { payloadHash } from "./canonical.js";
import { type CardChange, cardProvider } from "./cards.js";
import { MoneyError } from "./errors.js";
import { balanceMinor, postTransaction, type Tx } from "./ledger.js";
import { type Role, isParentRole, policyFor } from "./policy.js";
import { assertTimeZone, localDateKey, nextAllowanceAt, weeklyPathMinor } from "./schedule.js";

export interface Actor {
  memberId: string;
  familyId: string;
  role: Role;
}

export interface CommandOutcome {
  commandId: string;
  status: string;
  replayed: boolean;
  result: Record<string, unknown> | null;
}

export interface ApprovalOutcome {
  approvalId: string;
  status: string;
  replayed: boolean;
  result: Record<string, unknown> | null;
}

type CommandRow = typeof moneyCommands.$inferSelect;
type Executor = Tx | Database;

const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWANCE_RETRY_MS = 60 * 60 * 1000;
const aud = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export const DEFAULT_CARD = {
  frozen: false,
  dailyLimitMinor: 50_00,
  online: true,
  atm: false,
  inApp: true,
} as const;

async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  resourceId: string,
  metadata?: Record<string, unknown>,
) {
  await tx.insert(auditEvents).values({
    familyId: actor.familyId,
    actorMemberId: actor.memberId,
    action,
    resourceType: "money_command",
    resourceId,
    metadata: metadata ?? null,
  });
}

function assertSelf(actor: Actor, memberId: string): void {
  if (actor.role === "child" && actor.memberId !== memberId) {
    throw new MoneyError("CROSS_MEMBER_FORBIDDEN", "you can only do that for yourself");
  }
}

async function childOf(tx: Executor, familyId: string, memberId: string) {
  const [child] = await tx
    .select()
    .from(familyMembers)
    .where(
      and(
        eq(familyMembers.id, memberId),
        eq(familyMembers.familyId, familyId),
        eq(familyMembers.role, "child"),
        ne(familyMembers.status, "removed"),
      ),
    )
    .limit(1);
  if (!child) throw new MoneyError("CHILD_NOT_FOUND", "that child is not in this family");
  return child;
}

async function nameOf(tx: Executor, memberId: string): Promise<string> {
  const [row] = await tx
    .select({ displayName: familyMembers.displayName })
    .from(familyMembers)
    .where(eq(familyMembers.id, memberId))
    .limit(1);
  return row?.displayName ?? "Your child";
}

async function createApproval(tx: Tx, actor: Actor, commandId: string, commandHash: string) {
  const [approval] = await tx
    .insert(approvals)
    .values({
      familyId: actor.familyId,
      commandId,
      commandHash,
      requestedByMemberId: actor.memberId,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    })
    .returning({ id: approvals.id });
  return approval!.id;
}

/** A command the engine creates on a child's behalf, waiting for a parent. */
async function createDerived(
  tx: Tx,
  actor: Actor,
  parentCommandId: string,
  kind: string,
  payload: Record<string, unknown>,
  display: CommandDisplay,
): Promise<string> {
  const hash = payloadHash({ command: kind, payload });
  const [derived] = await tx
    .insert(moneyCommands)
    .values({
      familyId: actor.familyId,
      actorMemberId: actor.memberId,
      kind,
      payload,
      payloadHash: hash,
      idempotencyKey: `derived:${parentCommandId}`,
      status: "approval_pending",
      display,
    })
    .returning({ id: moneyCommands.id });
  return createApproval(tx, actor, derived!.id, hash);
}

/**
 * The single entry point for a money request. Denials are audited and refused
 * before anything is written; everything else runs in one transaction, so a
 * failure part-way (insufficient funds, a provider error) leaves no half-done
 * state and a retry with the same key simply tries again.
 */
export async function submitCommand(
  db: Database,
  actor: Actor,
  proposal: MoneyCommand,
  idempotencyKey: string,
): Promise<CommandOutcome> {
  const decision = policyFor(actor.role, proposal);
  if (decision.type === "deny") {
    await db.insert(auditEvents).values({
      familyId: actor.familyId,
      actorMemberId: actor.memberId,
      action: "money.command.denied",
      resourceType: "money_command",
      metadata: { command: proposal.command, code: decision.code },
    });
    throw new MoneyError(decision.code, decision.message);
  }

  const hash = payloadHash({ command: proposal.command, payload: proposal.payload });
  const needsApproval = decision.type === "require_approval";

  return db.transaction(async (tx) => {
    await openFamilyAccounts(tx, actor.familyId);

    const [inserted] = await tx
      .insert(moneyCommands)
      .values({
        familyId: actor.familyId,
        actorMemberId: actor.memberId,
        kind: proposal.command,
        payload: proposal.payload as Record<string, unknown>,
        payloadHash: hash,
        idempotencyKey,
        status: needsApproval ? "approval_pending" : "executing",
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(moneyCommands)
        .where(
          and(
            eq(moneyCommands.familyId, actor.familyId),
            eq(moneyCommands.actorMemberId, actor.memberId),
            eq(moneyCommands.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) throw new MoneyError("IDEMPOTENCY_CONFLICT", "idempotency key conflict");
      if (existing.payloadHash !== hash) {
        throw new MoneyError(
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "that idempotency key was already used for a different request",
        );
      }
      return { commandId: existing.id, status: existing.status, replayed: true, result: existing.result };
    }

    if (needsApproval) {
      const { display } = await approvalDisplay(tx, actor, proposal);
      const approvalId = await createApproval(tx, actor, inserted.id, hash);
      const result = { approvalId };
      await tx.update(moneyCommands).set({ display, result }).where(eq(moneyCommands.id, inserted.id));
      await audit(tx, actor, `money.${proposal.command}.requested`, inserted.id, result);
      return { commandId: inserted.id, status: "approval_pending", replayed: false, result };
    }

    const result = await execute(tx, actor, inserted.id, proposal);
    await tx
      .update(moneyCommands)
      .set({ status: "executed", result, updatedAt: new Date() })
      .where(eq(moneyCommands.id, inserted.id));
    await audit(tx, actor, `money.${proposal.command}`, inserted.id, result);
    return { commandId: inserted.id, status: "executed", replayed: false, result };
  });
}

/** Only a child's Save-to-Spend move waits for a parent at the top level; everything else is derived. */
async function approvalDisplay(tx: Tx, actor: Actor, proposal: MoneyCommand): Promise<{ display: CommandDisplay }> {
  if (proposal.command !== "savings.move") {
    throw new MoneyError("APPROVAL_UNSUPPORTED", "that request cannot wait for approval");
  }
  assertSelf(actor, proposal.payload.childMemberId);
  const child = await childOf(tx, actor.familyId, proposal.payload.childMemberId);
  return {
    display: {
      title: `${child.displayName} wants to move ${aud(proposal.payload.amountMinor)} from Save to Spend`,
      detail: "Approving moves it straight away.",
      confirmLabel: `Approve ${aud(proposal.payload.amountMinor)}`,
      cancelLabel: "Decline",
    },
  };
}

async function execute(
  tx: Tx,
  actor: Actor,
  commandId: string,
  proposal: MoneyCommand,
): Promise<Record<string, unknown>> {
  const { familyId } = actor;

  switch (proposal.command) {
    case "wallet.topup": {
      const { amountMinor, title } = proposal.payload;
      const funding = await accountId(tx, familyId, "external_funding");
      const wallet = await accountId(tx, familyId, "family_wallet");
      const posted = await postTransaction(tx, {
        familyId,
        kind: "topup",
        idempotencyKey: `command:${commandId}`,
        commandId,
        actorMemberId: actor.memberId,
        postings: [
          { accountId: funding, direction: "debit", amountMinor },
          { accountId: wallet, direction: "credit", amountMinor },
        ],
        metadata: { title },
      });
      return { transactionId: posted.transactionId, amountMinor };
    }

    case "money.transfer": {
      const { childMemberId, destination, amountMinor, title } = proposal.payload;
      const child = await childOf(tx, familyId, childMemberId);
      await openMemberAccounts(tx, familyId, child.id);
      const wallet = await accountId(tx, familyId, "family_wallet");
      const dest = await accountId(tx, familyId, destination, child.id);
      const posted = await postTransaction(tx, {
        familyId,
        kind: "transfer",
        idempotencyKey: `command:${commandId}`,
        commandId,
        actorMemberId: actor.memberId,
        postings: [
          { accountId: wallet, direction: "debit", amountMinor },
          { accountId: dest, direction: "credit", amountMinor },
        ],
        metadata: { title, childMemberId: child.id, destination },
      });
      return { transactionId: posted.transactionId, childMemberId: child.id, destination, amountMinor };
    }

    case "chore.assign": {
      const { childMemberId, title, detail, rewardMinor, destination } = proposal.payload;
      const child = await childOf(tx, familyId, childMemberId);
      await openMemberAccounts(tx, familyId, child.id);
      const [chore] = await tx
        .insert(chores)
        .values({
          familyId,
          assignedMemberId: child.id,
          createdByMemberId: actor.memberId,
          title,
          detail: detail ?? null,
          rewardMinor,
          destination,
        })
        .returning({ id: chores.id });
      return { choreId: chore!.id };
    }

    case "chore.submit": {
      const [chore] = await tx
        .select()
        .from(chores)
        .where(and(eq(chores.id, proposal.payload.choreId), eq(chores.familyId, familyId)))
        .limit(1)
        .for("update");
      if (!chore) throw new MoneyError("CHORE_NOT_FOUND", "that chore was not found");
      if (actor.role === "child" && chore.assignedMemberId !== actor.memberId) {
        throw new MoneyError("CHORE_NOT_YOURS", "that chore belongs to someone else");
      }
      if (chore.status !== "open" && chore.status !== "redo") {
        throw new MoneyError("CHORE_NOT_SUBMITTABLE", `that chore is already ${chore.status}`);
      }
      await tx
        .update(chores)
        .set({ status: "submitted", submittedAt: new Date(), redoNote: null, updatedAt: new Date() })
        .where(eq(chores.id, chore.id));

      const name = await nameOf(tx, chore.assignedMemberId);
      const approvalId = await createDerived(tx, actor, commandId, "chore.pay", { choreId: chore.id }, {
        title: `${name} finished “${chore.title}”`,
        detail:
          chore.rewardMinor > 0
            ? `Approving pays ${aud(chore.rewardMinor)} into their ${chore.destination === "save" ? "Save" : "Spend"} account.`
            : "No reward on this chore.",
        confirmLabel: chore.rewardMinor > 0 ? `Approve & pay ${aud(chore.rewardMinor)}` : "Approve",
        cancelLabel: "Needs redo",
      });
      return { choreId: chore.id, approvalId };
    }

    case "spend.request": {
      const { amountMinor, title, reason } = proposal.payload;
      await openMemberAccounts(tx, familyId, actor.memberId);
      const spend = await accountId(tx, familyId, "spend", actor.memberId);
      const available = await balanceMinor(tx, spend);
      if (available < amountMinor) {
        throw new MoneyError(
          "INSUFFICIENT_FUNDS",
          `You have ${aud(available)} in Spend, so you can't ask for ${aud(amountMinor)} yet.`,
          { availableMinor: available, requiredMinor: amountMinor },
        );
      }
      const [request] = await tx
        .insert(spendRequests)
        .values({ familyId, requesterMemberId: actor.memberId, title, reason: reason ?? null, amountMinor })
        .returning({ id: spendRequests.id });

      const name = await nameOf(tx, actor.memberId);
      const approvalId = await createDerived(tx, actor, commandId, "spend.pay", { requestId: request!.id }, {
        title: `${name} asks to spend ${aud(amountMinor)}`,
        detail: reason ? `“${title}” — ${reason}` : `“${title}”`,
        confirmLabel: `Approve ${aud(amountMinor)}`,
        cancelLabel: "Decline",
      });
      await tx.update(spendRequests).set({ approvalId }).where(eq(spendRequests.id, request!.id));
      return { requestId: request!.id, approvalId };
    }

    case "savings.goal.create": {
      const { childMemberId, title, targetMinor, targetDate } = proposal.payload;
      assertSelf(actor, childMemberId);
      const child = await childOf(tx, familyId, childMemberId);
      const [goal] = await tx
        .insert(savingsGoals)
        .values({
          familyId,
          ownerMemberId: child.id,
          title,
          targetMinor,
          targetDate: targetDate ?? null,
          createdByMemberId: actor.memberId,
        })
        .returning({ id: savingsGoals.id });
      return { goalId: goal!.id };
    }

    case "savings.move": {
      assertSelf(actor, proposal.payload.childMemberId);
      await childOf(tx, familyId, proposal.payload.childMemberId);
      return moveSavings(tx, actor, commandId, proposal.payload);
    }

    case "savings.boost": {
      const { childMemberId, amountMinor, title } = proposal.payload;
      const child = await childOf(tx, familyId, childMemberId);
      await openMemberAccounts(tx, familyId, child.id);
      const wallet = await accountId(tx, familyId, "family_wallet");
      const save = await accountId(tx, familyId, "save", child.id);
      const posted = await postTransaction(tx, {
        familyId,
        kind: "boost",
        idempotencyKey: `command:${commandId}`,
        commandId,
        actorMemberId: actor.memberId,
        postings: [
          { accountId: wallet, direction: "debit", amountMinor },
          { accountId: save, direction: "credit", amountMinor },
        ],
        metadata: { title: title ?? "Savings boost", childMemberId: child.id },
      });
      return { transactionId: posted.transactionId, childMemberId: child.id, amountMinor };
    }

    case "allowance.set": {
      const { childMemberId, amountMinor, weekday, spendBasisPoints, timeZone } = proposal.payload;
      const child = await childOf(tx, familyId, childMemberId);
      assertTimeZone(timeZone);
      const nextRunAt = nextAllowanceAt(new Date(), weekday, timeZone);
      const [schedule] = await tx
        .insert(allowanceSchedules)
        .values({
          familyId,
          childMemberId: child.id,
          amountMinor,
          weekday,
          spendBasisPoints,
          timeZone,
          nextRunAt,
          createdByMemberId: actor.memberId,
        })
        .onConflictDoUpdate({
          target: allowanceSchedules.childMemberId,
          set: { amountMinor, weekday, spendBasisPoints, timeZone, nextRunAt, status: "active", retryAt: null, updatedAt: new Date() },
        })
        .returning({ id: allowanceSchedules.id });
      return { scheduleId: schedule!.id, nextRunAt: nextRunAt.toISOString() };
    }

    case "allowance.pause": {
      const { childMemberId, paused } = proposal.payload;
      await childOf(tx, familyId, childMemberId);
      const [schedule] = await tx
        .select()
        .from(allowanceSchedules)
        .where(and(eq(allowanceSchedules.childMemberId, childMemberId), eq(allowanceSchedules.familyId, familyId)))
        .limit(1)
        .for("update");
      if (!schedule) throw new MoneyError("ALLOWANCE_NOT_FOUND", "there is no allowance to change");
      // Resuming starts from the next occurrence; missed weeks are not back-paid.
      const nextRunAt = paused ? schedule.nextRunAt : nextAllowanceAt(new Date(), schedule.weekday, schedule.timeZone);
      await tx
        .update(allowanceSchedules)
        .set({ status: paused ? "paused" : "active", nextRunAt, retryAt: null, updatedAt: new Date() })
        .where(eq(allowanceSchedules.id, schedule.id));
      return { scheduleId: schedule.id, status: paused ? "paused" : "active", nextRunAt: nextRunAt.toISOString() };
    }

    case "card.freeze":
      assertSelf(actor, proposal.payload.childMemberId);
      return applyCard(tx, actor, { memberId: proposal.payload.childMemberId, frozen: proposal.payload.frozen });

    case "card.limit":
      return applyCard(tx, actor, {
        memberId: proposal.payload.childMemberId,
        dailyLimitMinor: proposal.payload.dailyLimitMinor,
      });

    case "card.channel":
      return applyCard(tx, actor, {
        memberId: proposal.payload.childMemberId,
        channel: { name: proposal.payload.channel, enabled: proposal.payload.enabled },
      });
  }
}

async function moveSavings(
  tx: Tx,
  actor: Actor,
  commandId: string,
  move: { childMemberId: string; direction: "to_save" | "to_spend"; amountMinor: number },
): Promise<Record<string, unknown>> {
  await openMemberAccounts(tx, actor.familyId, move.childMemberId);
  const spend = await accountId(tx, actor.familyId, "spend", move.childMemberId);
  const save = await accountId(tx, actor.familyId, "save", move.childMemberId);
  const [from, to] = move.direction === "to_save" ? [spend, save] : [save, spend];
  const posted = await postTransaction(tx, {
    familyId: actor.familyId,
    kind: "savings_move",
    idempotencyKey: `command:${commandId}`,
    commandId,
    actorMemberId: actor.memberId,
    postings: [
      { accountId: from, direction: "debit", amountMinor: move.amountMinor },
      { accountId: to, direction: "credit", amountMinor: move.amountMinor },
    ],
    metadata: {
      title: move.direction === "to_save" ? "Moved to Save" : "Moved to Spend",
      childMemberId: move.childMemberId,
    },
  });
  return { transactionId: posted.transactionId, ...move };
}

async function cardFor(tx: Executor, memberId: string) {
  const [card] = await tx.select().from(cardControls).where(eq(cardControls.memberId, memberId)).limit(1);
  return card ?? { ...DEFAULT_CARD, memberId };
}

/**
 * The provider is called inside the database transaction, so a provider
 * refusal rolls back the local change and nothing claims to have happened.
 * A real issuer will need an outbox here: a commit failing after the provider
 * accepted would otherwise leave the two disagreeing.
 */
async function applyCard(tx: Tx, actor: Actor, change: CardChange): Promise<Record<string, unknown>> {
  const child = await childOf(tx, actor.familyId, change.memberId);
  await tx.insert(cardControls).values({ familyId: actor.familyId, memberId: child.id }).onConflictDoNothing();
  const [card] = await tx
    .select()
    .from(cardControls)
    .where(eq(cardControls.memberId, child.id))
    .limit(1)
    .for("update");

  const provider = cardProvider();
  const applied = await provider.apply(change);
  if (!applied.ok) {
    throw new MoneyError(
      "PROVIDER_FAILED",
      "The card provider could not make that change, so nothing was changed.",
      { error: applied.error },
    );
  }

  const channelColumn =
    change.channel?.name === "in_app" ? "inApp" : change.channel?.name === "atm" ? "atm" : "online";
  const [updated] = await tx
    .update(cardControls)
    .set({
      ...(change.frozen === undefined ? {} : { frozen: change.frozen }),
      ...(change.dailyLimitMinor === undefined ? {} : { dailyLimitMinor: change.dailyLimitMinor }),
      ...(change.channel ? { [channelColumn]: change.channel.enabled } : {}),
      provider: provider.name,
      providerStatus: "applied",
      updatedAt: new Date(),
    })
    .where(eq(cardControls.id, card!.id))
    .returning();

  return {
    memberId: child.id,
    frozen: updated!.frozen,
    dailyLimitMinor: updated!.dailyLimitMinor,
    online: updated!.online,
    atm: updated!.atm,
    inApp: updated!.inApp,
    providerReference: applied.reference,
  };
}

/**
 * A parent's decision on a pending approval. Deciding the same way twice
 * returns the first outcome, so a double-tapped "Approve" pays once.
 */
export async function decideApproval(
  db: Database,
  actor: Actor,
  approvalId: string,
  decision: "approve" | "reject",
  note?: string,
): Promise<ApprovalOutcome> {
  if (!isParentRole(actor.role)) {
    throw new MoneyError("PARENT_ONLY", "only a parent can decide this");
  }

  return db.transaction(async (tx) => {
    const [approval] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.familyId, actor.familyId)))
      .limit(1)
      .for("update");
    if (!approval) throw new MoneyError("APPROVAL_NOT_FOUND", "that approval was not found");

    const [command] = await tx
      .select()
      .from(moneyCommands)
      .where(eq(moneyCommands.id, approval.commandId))
      .limit(1)
      .for("update");

    if (approval.status !== "pending") {
      const sameDecision =
        (approval.status === "approved" && decision === "approve") ||
        (approval.status === "rejected" && decision === "reject");
      if (sameDecision) {
        return { approvalId, status: approval.status, replayed: true, result: command?.result ?? null };
      }
      throw new MoneyError("APPROVAL_ALREADY_DECIDED", `this was already ${approval.status}`);
    }

    if (approval.expiresAt <= new Date()) {
      await tx.update(approvals).set({ status: "expired" }).where(eq(approvals.id, approval.id));
      throw new MoneyError("APPROVAL_EXPIRED", "this request expired before it was decided");
    }

    if (!command || payloadHash({ command: command.kind, payload: command.payload }) !== approval.commandHash) {
      throw new MoneyError("APPROVAL_TAMPERED", "the request changed after it was sent for approval");
    }

    const result =
      decision === "approve"
        ? await executeApproved(tx, actor, command)
        : await declineApproved(tx, actor, command, note);

    await tx
      .update(moneyCommands)
      .set({ status: decision === "approve" ? "executed" : "rejected", result, updatedAt: new Date() })
      .where(eq(moneyCommands.id, command.id));

    const status = decision === "approve" ? "approved" : "rejected";
    await tx
      .update(approvals)
      .set({ status, decidedByMemberId: actor.memberId, decidedAt: new Date() })
      .where(eq(approvals.id, approval.id));

    await audit(tx, actor, `money.approval.${status}`, command.id, result);
    return { approvalId, status, replayed: false, result };
  });
}

async function executeApproved(tx: Tx, approver: Actor, command: CommandRow): Promise<Record<string, unknown>> {
  switch (command.kind) {
    case "chore.pay":
      return payChore(tx, approver, command.id, String(command.payload["choreId"]));
    case "spend.pay":
      return paySpend(tx, approver, command.id, String(command.payload["requestId"]));
    case "savings.move":
      return moveSavings(tx, approver, command.id, SavingsMove.shape.payload.parse(command.payload));
    default:
      throw new MoneyError("APPROVAL_UNSUPPORTED", `cannot approve ${command.kind}`);
  }
}

async function declineApproved(
  tx: Tx,
  approver: Actor,
  command: CommandRow,
  note?: string,
): Promise<Record<string, unknown>> {
  switch (command.kind) {
    case "chore.pay": {
      const choreId = String(command.payload["choreId"]);
      await tx
        .update(chores)
        .set({ status: "redo", redoNote: note ?? null, updatedAt: new Date() })
        .where(and(eq(chores.id, choreId), eq(chores.familyId, approver.familyId)));
      return { choreId, redo: true };
    }
    case "spend.pay": {
      const requestId = String(command.payload["requestId"]);
      await tx
        .update(spendRequests)
        .set({ status: "declined", decidedByMemberId: approver.memberId, decidedAt: new Date() })
        .where(and(eq(spendRequests.id, requestId), eq(spendRequests.status, "pending")));
      return { requestId, declined: true };
    }
    default:
      return { declined: true };
  }
}

async function payChore(tx: Tx, actor: Actor, commandId: string, choreId: string): Promise<Record<string, unknown>> {
  const [chore] = await tx
    .select()
    .from(chores)
    .where(and(eq(chores.id, choreId), eq(chores.familyId, actor.familyId)))
    .limit(1)
    .for("update");
  if (!chore || chore.status !== "submitted") {
    throw new MoneyError("CHORE_NOT_REVIEWABLE", "that chore is not waiting for review");
  }

  let transactionId: string | null = null;
  if (chore.rewardMinor > 0) {
    await openMemberAccounts(tx, actor.familyId, chore.assignedMemberId);
    const wallet = await accountId(tx, actor.familyId, "family_wallet");
    const dest = await accountId(tx, actor.familyId, chore.destination, chore.assignedMemberId);
    const posted = await postTransaction(tx, {
      familyId: actor.familyId,
      kind: "chore",
      idempotencyKey: `command:${commandId}`,
      commandId,
      actorMemberId: actor.memberId,
      postings: [
        { accountId: wallet, direction: "debit", amountMinor: chore.rewardMinor },
        { accountId: dest, direction: "credit", amountMinor: chore.rewardMinor },
      ],
      metadata: { title: chore.title, choreId: chore.id },
    });
    transactionId = posted.transactionId;
  }

  await tx
    .update(chores)
    .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
    .where(eq(chores.id, chore.id));

  return { choreId: chore.id, amountMinor: chore.rewardMinor, destination: chore.destination, transactionId };
}

async function spentTodayMinor(tx: Tx, spendAccountId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [row] = await tx
    .select({ minor: sql<string>`coalesce(sum(${ledgerEntries.amountMinor}), 0)` })
    .from(ledgerEntries)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(
      and(
        eq(ledgerEntries.accountId, spendAccountId),
        eq(ledgerEntries.direction, "debit"),
        eq(ledgerTransactions.kind, "spend"),
        gte(ledgerTransactions.createdAt, startOfDay),
      ),
    );
  return Number(row?.minor ?? 0);
}

/** Card controls are checked when money leaves, not when it is asked for — they can change in between. */
async function paySpend(tx: Tx, actor: Actor, commandId: string, requestId: string): Promise<Record<string, unknown>> {
  const [request] = await tx
    .select()
    .from(spendRequests)
    .where(and(eq(spendRequests.id, requestId), eq(spendRequests.familyId, actor.familyId)))
    .limit(1)
    .for("update");
  if (!request || request.status !== "pending") {
    throw new MoneyError("REQUEST_NOT_PENDING", "that request has already been decided");
  }

  const card = await cardFor(tx, request.requesterMemberId);
  if (card.frozen) {
    throw new MoneyError("CARD_FROZEN", "That card is frozen. Unfreeze it first, or decline the request.");
  }
  if (!card.inApp) {
    throw new MoneyError("CHANNEL_DISABLED", "In-app spending is turned off for this card.");
  }

  await openMemberAccounts(tx, actor.familyId, request.requesterMemberId);
  const spend = await accountId(tx, actor.familyId, "spend", request.requesterMemberId);
  const outside = await accountId(tx, actor.familyId, "external_funding");

  const spent = await spentTodayMinor(tx, spend);
  if (spent + request.amountMinor > card.dailyLimitMinor) {
    throw new MoneyError(
      "DAILY_LIMIT_EXCEEDED",
      `That would pass the ${aud(card.dailyLimitMinor)} daily limit (${aud(spent)} spent today).`,
      { spentTodayMinor: spent, dailyLimitMinor: card.dailyLimitMinor },
    );
  }

  const posted = await postTransaction(tx, {
    familyId: actor.familyId,
    kind: "spend",
    idempotencyKey: `command:${commandId}`,
    commandId,
    actorMemberId: actor.memberId,
    postings: [
      { accountId: spend, direction: "debit", amountMinor: request.amountMinor },
      { accountId: outside, direction: "credit", amountMinor: request.amountMinor },
    ],
    metadata: { title: request.title, requestId: request.id },
  });

  await tx
    .update(spendRequests)
    .set({ status: "approved", decidedByMemberId: actor.memberId, decidedAt: new Date() })
    .where(eq(spendRequests.id, request.id));

  return { requestId: request.id, transactionId: posted.transactionId, amountMinor: request.amountMinor };
}

export interface AllowanceRunReport {
  scheduleId: string;
  outcome: "paid" | "already_paid" | "failed" | "skipped";
  periodKey?: string;
  transactionId?: string;
  code?: string;
}

/**
 * Pays every allowance that is due. Each schedule runs in its own transaction
 * and is locked with SKIP LOCKED, so two workers never pay the same one. A run
 * that cannot be funded is recorded as failed — never as paid — and retried
 * after a back-off, for the same period.
 */
export async function runDueAllowances(
  db: Database,
  opts: { now?: Date; familyId?: string } = {},
): Promise<AllowanceRunReport[]> {
  const now = opts.now ?? new Date();
  const due = await db
    .select({ id: allowanceSchedules.id })
    .from(allowanceSchedules)
    .where(
      and(
        eq(allowanceSchedules.status, "active"),
        lte(allowanceSchedules.nextRunAt, now),
        or(isNull(allowanceSchedules.retryAt), lte(allowanceSchedules.retryAt, now)),
        ...(opts.familyId ? [eq(allowanceSchedules.familyId, opts.familyId)] : []),
      ),
    )
    .orderBy(allowanceSchedules.nextRunAt)
    .limit(100);

  const reports: AllowanceRunReport[] = [];
  for (const { id } of due) reports.push(await runAllowance(db, id, now));
  return reports;
}

async function runAllowance(db: Database, scheduleId: string, now: Date): Promise<AllowanceRunReport> {
  try {
    return await db.transaction(async (tx) => {
      const [schedule] = await tx
        .select()
        .from(allowanceSchedules)
        .where(
          and(
            eq(allowanceSchedules.id, scheduleId),
            eq(allowanceSchedules.status, "active"),
            lte(allowanceSchedules.nextRunAt, now),
          ),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (!schedule) return { scheduleId, outcome: "skipped" };

      const periodKey = localDateKey(schedule.nextRunAt, schedule.timeZone);
      const next = nextAllowanceAt(schedule.nextRunAt, schedule.weekday, schedule.timeZone);

      const [paid] = await tx
        .select({ id: allowanceRuns.id })
        .from(allowanceRuns)
        .where(
          and(
            eq(allowanceRuns.scheduleId, schedule.id),
            eq(allowanceRuns.periodKey, periodKey),
            eq(allowanceRuns.status, "succeeded"),
          ),
        )
        .limit(1);
      if (paid) {
        await tx
          .update(allowanceSchedules)
          .set({ nextRunAt: next, retryAt: null, updatedAt: new Date() })
          .where(eq(allowanceSchedules.id, schedule.id));
        return { scheduleId, periodKey, outcome: "already_paid" };
      }

      const saveMinor = Math.round((schedule.amountMinor * (10_000 - schedule.spendBasisPoints)) / 10_000);
      const spendMinor = schedule.amountMinor - saveMinor;

      await openFamilyAccounts(tx, schedule.familyId);
      await openMemberAccounts(tx, schedule.familyId, schedule.childMemberId);
      const wallet = await accountId(tx, schedule.familyId, "family_wallet");
      const spend = await accountId(tx, schedule.familyId, "spend", schedule.childMemberId);
      const save = await accountId(tx, schedule.familyId, "save", schedule.childMemberId);

      const posted = await postTransaction(tx, {
        familyId: schedule.familyId,
        kind: "allowance",
        idempotencyKey: `allowance:${schedule.id}:${periodKey}`,
        postings: [
          { accountId: wallet, direction: "debit", amountMinor: schedule.amountMinor },
          ...(spendMinor > 0 ? [{ accountId: spend, direction: "credit" as const, amountMinor: spendMinor }] : []),
          ...(saveMinor > 0 ? [{ accountId: save, direction: "credit" as const, amountMinor: saveMinor }] : []),
        ],
        metadata: { title: "Weekly allowance", scheduleId: schedule.id, periodKey, spendMinor, saveMinor },
      });

      await tx
        .insert(allowanceRuns)
        .values({
          familyId: schedule.familyId,
          scheduleId: schedule.id,
          periodKey,
          status: "succeeded",
          amountMinor: schedule.amountMinor,
          transactionId: posted.transactionId,
        })
        .onConflictDoUpdate({
          target: [allowanceRuns.scheduleId, allowanceRuns.periodKey],
          set: { status: "succeeded", transactionId: posted.transactionId, errorCode: null, updatedAt: new Date() },
        });

      await tx
        .update(allowanceSchedules)
        .set({ nextRunAt: next, retryAt: null, updatedAt: new Date() })
        .where(eq(allowanceSchedules.id, schedule.id));

      return { scheduleId, periodKey, outcome: "paid", transactionId: posted.transactionId };
    });
  } catch (error) {
    const code = error instanceof MoneyError ? error.code : "INTERNAL";
    // Written after the rollback, so the failure is visible and never mistaken for a payment.
    return db.transaction(async (tx) => {
      const [schedule] = await tx
        .select()
        .from(allowanceSchedules)
        .where(eq(allowanceSchedules.id, scheduleId))
        .limit(1);
      if (!schedule) return { scheduleId, outcome: "failed", code };
      const periodKey = localDateKey(schedule.nextRunAt, schedule.timeZone);
      await tx
        .insert(allowanceRuns)
        .values({
          familyId: schedule.familyId,
          scheduleId,
          periodKey,
          status: "failed",
          amountMinor: schedule.amountMinor,
          errorCode: code,
        })
        .onConflictDoUpdate({
          target: [allowanceRuns.scheduleId, allowanceRuns.periodKey],
          set: { status: "failed", errorCode: code, attempts: sql`${allowanceRuns.attempts} + 1`, updatedAt: new Date() },
          setWhere: ne(allowanceRuns.status, "succeeded"),
        });
      await tx
        .update(allowanceSchedules)
        .set({ retryAt: new Date(now.getTime() + ALLOWANCE_RETRY_MS), updatedAt: new Date() })
        .where(eq(allowanceSchedules.id, scheduleId));
      return { scheduleId, periodKey, outcome: "failed", code };
    });
  }
}

/** Parents see every child; a child sees only themselves. */
export async function visibleChildren(db: Database, actor: Actor) {
  return db
    .select({ id: familyMembers.id, displayName: familyMembers.displayName })
    .from(familyMembers)
    .where(
      and(
        eq(familyMembers.familyId, actor.familyId),
        eq(familyMembers.role, "child"),
        ne(familyMembers.status, "removed"),
        ...(isParentRole(actor.role) ? [] : [eq(familyMembers.id, actor.memberId)]),
      ),
    );
}

async function familyAccounts(db: Database, familyId: string) {
  return db
    .select({ id: moneyAccounts.id, purpose: moneyAccounts.purpose, owner: moneyAccounts.ownerMemberId })
    .from(moneyAccounts)
    .where(and(eq(moneyAccounts.familyId, familyId), eq(moneyAccounts.status, "active")));
}

async function balances(db: Database, familyId: string) {
  const accounts = await familyAccounts(db, familyId);
  return async (purpose: string, owner: string | null) => {
    const account = accounts.find((a) => a.purpose === purpose && a.owner === owner);
    return account ? balanceMinor(db, account.id) : 0;
  };
}

export interface WalletView {
  familyWalletMinor?: number;
  children: Array<{ memberId: string; displayName: string; spendMinor: number; saveMinor: number }>;
}

export async function walletFor(db: Database, actor: Actor): Promise<WalletView> {
  const kids = await visibleChildren(db, actor);
  const balanceOf = await balances(db, actor.familyId);
  const children = await Promise.all(
    kids.map(async (k) => ({
      memberId: k.id,
      displayName: k.displayName,
      spendMinor: await balanceOf("spend", k.id),
      saveMinor: await balanceOf("save", k.id),
    })),
  );
  return isParentRole(actor.role)
    ? { familyWalletMinor: await balanceOf("family_wallet", null), children }
    : { children };
}

export async function choresFor(db: Database, actor: Actor) {
  return db
    .select()
    .from(chores)
    .where(
      and(
        eq(chores.familyId, actor.familyId),
        ...(isParentRole(actor.role) ? [] : [eq(chores.assignedMemberId, actor.memberId)]),
      ),
    )
    .orderBy(desc(chores.createdAt));
}

export async function pendingApprovals(db: Database, actor: Actor) {
  if (!isParentRole(actor.role)) {
    throw new MoneyError("PARENT_ONLY", "only a parent can see approvals");
  }
  return db
    .select({
      id: approvals.id,
      kind: moneyCommands.kind,
      display: moneyCommands.display,
      requestedByMemberId: approvals.requestedByMemberId,
      expiresAt: approvals.expiresAt,
    })
    .from(approvals)
    .innerJoin(moneyCommands, eq(moneyCommands.id, approvals.commandId))
    .where(and(eq(approvals.familyId, actor.familyId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt));
}

export async function goalsFor(db: Database, actor: Actor) {
  const kids = await visibleChildren(db, actor);
  if (kids.length === 0) return [];
  const names = new Map(kids.map((k) => [k.id, k.displayName]));
  const balanceOf = await balances(db, actor.familyId);
  const rows = await db
    .select()
    .from(savingsGoals)
    .where(
      and(
        eq(savingsGoals.familyId, actor.familyId),
        eq(savingsGoals.status, "active"),
        inArray(savingsGoals.ownerMemberId, [...names.keys()]),
      ),
    )
    .orderBy(desc(savingsGoals.createdAt));

  return Promise.all(
    rows.map(async (goal) => {
      const savedMinor = await balanceOf("save", goal.ownerMemberId);
      return {
        id: goal.id,
        ownerMemberId: goal.ownerMemberId,
        ownerName: names.get(goal.ownerMemberId) ?? "",
        title: goal.title,
        targetMinor: goal.targetMinor,
        targetDate: goal.targetDate,
        savedMinor,
        achieved: savedMinor >= goal.targetMinor,
        weeklyPathMinor: weeklyPathMinor(goal.targetMinor, savedMinor, goal.targetDate),
      };
    }),
  );
}

export async function allowancesFor(db: Database, actor: Actor) {
  const kids = await visibleChildren(db, actor);
  if (kids.length === 0) return [];
  const names = new Map(kids.map((k) => [k.id, k.displayName]));
  const schedules = await db
    .select()
    .from(allowanceSchedules)
    .where(
      and(
        eq(allowanceSchedules.familyId, actor.familyId),
        inArray(allowanceSchedules.childMemberId, [...names.keys()]),
      ),
    );

  return Promise.all(
    schedules.map(async (s) => {
      const [lastRun] = await db
        .select({
          periodKey: allowanceRuns.periodKey,
          status: allowanceRuns.status,
          errorCode: allowanceRuns.errorCode,
          attempts: allowanceRuns.attempts,
        })
        .from(allowanceRuns)
        .where(eq(allowanceRuns.scheduleId, s.id))
        .orderBy(desc(allowanceRuns.updatedAt))
        .limit(1);
      return {
        id: s.id,
        childMemberId: s.childMemberId,
        childName: names.get(s.childMemberId) ?? "",
        amountMinor: s.amountMinor,
        spendBasisPoints: s.spendBasisPoints,
        weekday: s.weekday,
        timeZone: s.timeZone,
        status: s.status,
        nextRunAt: s.nextRunAt.toISOString(),
        lastRun: lastRun ?? null,
      };
    }),
  );
}

export async function cardsFor(db: Database, actor: Actor) {
  const kids = await visibleChildren(db, actor);
  if (kids.length === 0) return [];
  const rows = await db
    .select()
    .from(cardControls)
    .where(inArray(cardControls.memberId, kids.map((k) => k.id)));
  return kids.map((k) => {
    const card = rows.find((r) => r.memberId === k.id);
    return {
      memberId: k.id,
      displayName: k.displayName,
      frozen: card?.frozen ?? DEFAULT_CARD.frozen,
      dailyLimitMinor: card?.dailyLimitMinor ?? DEFAULT_CARD.dailyLimitMinor,
      online: card?.online ?? DEFAULT_CARD.online,
      atm: card?.atm ?? DEFAULT_CARD.atm,
      inApp: card?.inApp ?? DEFAULT_CARD.inApp,
      provider: card?.provider ?? "sandbox",
    };
  });
}

export async function requestsFor(db: Database, actor: Actor) {
  const kids = await visibleChildren(db, actor);
  if (kids.length === 0) return [];
  return db
    .select({
      id: spendRequests.id,
      requesterMemberId: spendRequests.requesterMemberId,
      title: spendRequests.title,
      reason: spendRequests.reason,
      amountMinor: spendRequests.amountMinor,
      status: spendRequests.status,
      createdAt: spendRequests.createdAt,
      decidedAt: spendRequests.decidedAt,
    })
    .from(spendRequests)
    .where(
      and(
        eq(spendRequests.familyId, actor.familyId),
        inArray(spendRequests.requesterMemberId, kids.map((k) => k.id)),
      ),
    )
    .orderBy(desc(spendRequests.createdAt))
    .limit(50);
}
