import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
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

export const goalStatus = pgEnum("goal_status", ["active", "archived"]);
export const spendRequestStatus = pgEnum("spend_request_status", [
  "pending",
  "approved",
  "declined",
]);
export const allowanceStatus = pgEnum("allowance_status", ["active", "paused"]);
export const allowanceRunStatus = pgEnum("allowance_run_status", ["succeeded", "failed"]);

/** Progress is never stored: it is the owner's Save balance, read from the ledger. */
export const savingsGoals = pgTable(
  "savings_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    ownerMemberId: uuid("owner_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    targetMinor: integer("target_minor").notNull(),
    targetDate: date("target_date"),
    status: goalStatus("status").notNull().default("active"),
    createdByMemberId: uuid("created_by_member_id").references(
      () => familyMembers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "savings_goals_target_range",
      sql`${table.targetMinor} > 0 and ${table.targetMinor} <= 1000000`,
    ),
    index("savings_goals_owner_idx").on(table.ownerMemberId),
  ],
);

export const spendRequests = pgTable(
  "spend_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    requesterMemberId: uuid("requester_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    reason: text("reason"),
    amountMinor: integer("amount_minor").notNull(),
    status: spendRequestStatus("status").notNull().default("pending"),
    approvalId: uuid("approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    decidedByMemberId: uuid("decided_by_member_id").references(
      () => familyMembers.id,
      { onDelete: "set null" },
    ),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "spend_requests_amount_range",
      sql`${table.amountMinor} > 0 and ${table.amountMinor} <= 1000000`,
    ),
    index("spend_requests_requester_idx").on(table.requesterMemberId),
  ],
);

/** One schedule per child. `retryAt` backs off a failed run without moving its period. */
export const allowanceSchedules = pgTable(
  "allowance_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    childMemberId: uuid("child_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    amountMinor: integer("amount_minor").notNull(),
    spendBasisPoints: integer("spend_basis_points").notNull(),
    weekday: integer("weekday").notNull(),
    timeZone: text("time_zone").notNull(),
    status: allowanceStatus("status").notNull().default("active"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    retryAt: timestamp("retry_at", { withTimezone: true }),
    createdByMemberId: uuid("created_by_member_id").references(
      () => familyMembers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("allowance_schedules_child_key").on(table.childMemberId),
    index("allowance_schedules_due_idx").on(table.status, table.nextRunAt),
    check(
      "allowance_schedules_ranges",
      sql`${table.amountMinor} > 0 and ${table.amountMinor} <= 1000000 and ${table.spendBasisPoints} between 0 and 10000 and ${table.weekday} between 0 and 6`,
    ),
  ],
);

/** One row per schedule per local date. The unique key is what stops a period paying twice. */
export const allowanceRuns = pgTable(
  "allowance_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => allowanceSchedules.id, { onDelete: "cascade" }),
    periodKey: text("period_key").notNull(),
    status: allowanceRunStatus("status").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    transactionId: uuid("transaction_id").references(() => ledgerTransactions.id, {
      onDelete: "set null",
    }),
    errorCode: text("error_code"),
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("allowance_runs_period_key").on(table.scheduleId, table.periodKey),
  ],
);

export const cardControls = pgTable(
  "card_controls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    frozen: boolean("frozen").notNull().default(false),
    dailyLimitMinor: integer("daily_limit_minor").notNull().default(5000),
    online: boolean("online").notNull().default(true),
    atm: boolean("atm").notNull().default(false),
    inApp: boolean("in_app").notNull().default(true),
    provider: text("provider").notNull().default("sandbox"),
    providerStatus: text("provider_status").notNull().default("applied"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("card_controls_member_key").on(table.memberId),
    check(
      "card_controls_limit_range",
      sql`${table.dailyLimitMinor} >= 0 and ${table.dailyLimitMinor} <= 100000`,
    ),
  ],
);

/** Inbound provider webhooks. The unique key makes a redelivered event a no-op. */
export const providerEvents = pgTable(
  "provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    familyId: uuid("family_id").references(() => families.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    payload: jsonb("payload"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_events_provider_event_key").on(table.provider, table.eventId),
  ],
);
