import type { MoneyCommand } from "@brainpal/contracts";
import {
  type CommandDisplay,
  type Database,
  approvals,
  auditEvents,
  chores,
  familyMembers,
  moneyAccounts,
  moneyCommands,
} from "@brainpal/database";
import { and, desc, eq, ne } from "drizzle-orm";

import { accountId, openFamilyAccounts, openMemberAccounts } from "./accounts.js";
import { payloadHash } from "./canonical.js";
import { MoneyError } from "./errors.js";
import { balanceMinor, postTransaction, type Tx } from "./ledger.js";
import { type Role, isParentRole, policyFor } from "./policy.js";

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

const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const aud = (minor: number) => `$${(minor / 100).toFixed(2)}`;

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

async function childOf(tx: Tx, familyId: string, memberId: string) {
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

/**
 * The single entry point for a money request. Denials are audited and refused
 * before anything is written; everything else runs in one transaction, so a
 * failure part-way (insufficient funds, say) leaves no half-done state and a
 * retry with the same key simply tries again.
 */
export async function submitCommand(
  db: Database,
  actor: Actor,
  proposal: MoneyCommand,
  idempotencyKey: string,
): Promise<CommandOutcome> {
  const decision = policyFor(actor.role, proposal.command);
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
        status: "executing",
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

    const result = await execute(tx, actor, inserted.id, proposal);
    await tx
      .update(moneyCommands)
      .set({ status: "executed", result, updatedAt: new Date() })
      .where(eq(moneyCommands.id, inserted.id));
    await audit(tx, actor, `money.${proposal.command}`, inserted.id, result);

    return { commandId: inserted.id, status: "executed", replayed: false, result };
  });
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

      const [child] = await tx
        .select({ displayName: familyMembers.displayName })
        .from(familyMembers)
        .where(eq(familyMembers.id, chore.assignedMemberId))
        .limit(1);

      const pay = { command: "chore.pay", payload: { choreId: chore.id } };
      const payHash = payloadHash(pay);
      const display: CommandDisplay = {
        title: `${child?.displayName ?? "Your child"} finished “${chore.title}”`,
        detail:
          chore.rewardMinor > 0
            ? `Approving pays ${aud(chore.rewardMinor)} into their ${chore.destination === "save" ? "Save" : "Spend"} account.`
            : "No reward on this chore.",
        confirmLabel: chore.rewardMinor > 0 ? `Approve & pay ${aud(chore.rewardMinor)}` : "Approve",
        cancelLabel: "Needs redo",
      };

      const [derived] = await tx
        .insert(moneyCommands)
        .values({
          familyId,
          actorMemberId: actor.memberId,
          kind: pay.command,
          payload: pay.payload,
          payloadHash: payHash,
          idempotencyKey: `derived:${commandId}`,
          status: "approval_pending",
          display,
        })
        .returning({ id: moneyCommands.id });

      const [approval] = await tx
        .insert(approvals)
        .values({
          familyId,
          commandId: derived!.id,
          commandHash: payHash,
          requestedByMemberId: actor.memberId,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        })
        .returning({ id: approvals.id });

      return { choreId: chore.id, approvalId: approval!.id };
    }
  }
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
        ? await payChore(tx, actor, command.id, command.payload)
        : await sendBack(tx, command.payload, note);

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

async function payChore(
  tx: Tx,
  actor: Actor,
  commandId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const choreId = String(payload["choreId"]);
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
      metadata: { choreId: chore.id },
    });
    transactionId = posted.transactionId;
  }

  await tx
    .update(chores)
    .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
    .where(eq(chores.id, chore.id));

  return {
    choreId: chore.id,
    amountMinor: chore.rewardMinor,
    destination: chore.destination,
    transactionId,
  };
}

async function sendBack(
  tx: Tx,
  payload: Record<string, unknown>,
  note?: string,
): Promise<Record<string, unknown>> {
  const choreId = String(payload["choreId"]);
  await tx
    .update(chores)
    .set({ status: "redo", redoNote: note ?? null, updatedAt: new Date() })
    .where(eq(chores.id, choreId));
  return { choreId, redo: true };
}

export interface WalletView {
  familyWalletMinor?: number;
  children: Array<{ memberId: string; displayName: string; spendMinor: number; saveMinor: number }>;
}

/** Parents see the family wallet and every child; a child sees only their own accounts. */
export async function walletFor(db: Database, actor: Actor): Promise<WalletView> {
  const parent = isParentRole(actor.role);
  const kids = await db
    .select({ id: familyMembers.id, displayName: familyMembers.displayName })
    .from(familyMembers)
    .where(
      and(
        eq(familyMembers.familyId, actor.familyId),
        eq(familyMembers.role, "child"),
        ne(familyMembers.status, "removed"),
        ...(parent ? [] : [eq(familyMembers.id, actor.memberId)]),
      ),
    );

  const accounts = await db
    .select({ id: moneyAccounts.id, purpose: moneyAccounts.purpose, owner: moneyAccounts.ownerMemberId })
    .from(moneyAccounts)
    .where(and(eq(moneyAccounts.familyId, actor.familyId), eq(moneyAccounts.status, "active")));

  const balanceOf = async (purpose: string, owner: string | null) => {
    const account = accounts.find((a) => a.purpose === purpose && a.owner === owner);
    return account ? balanceMinor(db, account.id) : 0;
  };

  const children = await Promise.all(
    kids.map(async (k) => ({
      memberId: k.id,
      displayName: k.displayName,
      spendMinor: await balanceOf("spend", k.id),
      saveMinor: await balanceOf("save", k.id),
    })),
  );

  return parent ? { familyWalletMinor: await balanceOf("family_wallet", null), children } : { children };
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
