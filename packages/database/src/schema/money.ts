import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { families, familyMembers } from "./identity.js";

export const accountPurpose = pgEnum("account_purpose", [
  "family_wallet",
  "external_funding",
  "spend",
  "save",
]);

export const entryDirection = pgEnum("entry_direction", ["debit", "credit"]);

export const choreStatus = pgEnum("chore_status", [
  "open",
  "submitted",
  "redo",
  "paid",
  "cancelled",
]);

export const choreDestination = pgEnum("chore_destination", ["spend", "save"]);

export const moneyCommandStatus = pgEnum("money_command_status", [
  "executing",
  "executed",
  "approval_pending",
  "rejected",
]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
]);

/** What a parent sees on an approval card. Always derived server-side, never taken from a request. */
export interface CommandDisplay {
  title: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * A family has one wallet and one external-funding account; each child has a
 * Spend and a Save account. Balances are never stored — they are the sum of
 * `ledger_entries`, so there is no second number that can drift from the first.
 */
export const moneyAccounts = pgTable(
  "money_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    ownerMemberId: uuid("owner_member_id").references(() => familyMembers.id, {
      onDelete: "cascade",
    }),
    purpose: accountPurpose("purpose").notNull(),
    currency: text("currency").notNull().default("AUD"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("money_accounts_family_purpose_key")
      .on(table.familyId, table.purpose)
      .where(sql`${table.ownerMemberId} is null`),
    uniqueIndex("money_accounts_member_purpose_key")
      .on(table.familyId, table.ownerMemberId, table.purpose)
      .where(sql`${table.ownerMemberId} is not null`),
  ],
);

/**
 * Every consequential money request, whether it executed at once or is waiting
 * on a parent. Idempotent per actor: the same key with the same payload replays
 * the stored outcome; the same key with a different payload is refused.
 */
export const moneyCommands = pgTable(
  "money_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    actorMemberId: uuid("actor_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: moneyCommandStatus("status").notNull(),
    display: jsonb("display").$type<CommandDisplay>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("money_commands_actor_key").on(
      table.familyId,
      table.actorMemberId,
      table.idempotencyKey,
    ),
    index("money_commands_family_created_idx").on(table.familyId, table.createdAt),
  ],
);

/**
 * `commandHash` pins the approval to the exact payload the parent was shown. If
 * the command changes afterwards, the hash no longer matches and approving it
 * is refused.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    commandId: uuid("command_id")
      .notNull()
      .references(() => moneyCommands.id, { onDelete: "cascade" }),
    commandHash: text("command_hash").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    requestedByMemberId: uuid("requested_by_member_id").references(
      () => familyMembers.id,
      { onDelete: "set null" },
    ),
    decidedByMemberId: uuid("decided_by_member_id").references(
      () => familyMembers.id,
      { onDelete: "set null" },
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("approvals_command_key").on(table.commandId),
    index("approvals_family_status_idx").on(table.familyId, table.status),
  ],
);

export const chores = pgTable(
  "chores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    assignedMemberId: uuid("assigned_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    createdByMemberId: uuid("created_by_member_id").references(
      () => familyMembers.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    detail: text("detail"),
    rewardMinor: integer("reward_minor").notNull(),
    destination: choreDestination("destination").notNull().default("spend"),
    status: choreStatus("status").notNull().default("open"),
    redoNote: text("redo_note"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "chores_reward_range",
      sql`${table.rewardMinor} >= 0 and ${table.rewardMinor} <= 100000`,
    ),
    index("chores_family_idx").on(table.familyId),
    index("chores_assigned_idx").on(table.assignedMemberId),
  ],
);

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandId: uuid("command_id").references(() => moneyCommands.id, {
      onDelete: "set null",
    }),
    createdByMemberId: uuid("created_by_member_id").references(
      () => familyMembers.id,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ledger_transactions_idempotency_key").on(table.idempotencyKey),
    index("ledger_transactions_family_created_idx").on(
      table.familyId,
      table.createdAt,
    ),
  ],
);

/** Integer minor units (cents). A database trigger rejects any transaction whose entries do not balance. */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => moneyAccounts.id, { onDelete: "cascade" }),
    direction: entryDirection("direction").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("ledger_entries_amount_positive", sql`${table.amountMinor} > 0`),
    index("ledger_entries_account_idx").on(table.accountId),
    index("ledger_entries_transaction_idx").on(table.transactionId),
  ],
);
