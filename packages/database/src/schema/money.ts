import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
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

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandId: uuid("command_id"),
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
