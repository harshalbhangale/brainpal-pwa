import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { avatarStyle, familyRole, memberStatus } from "./enums.js";

/**
 * An authenticated principal. `authSubject` is the identity-provider subject —
 * a Cognito `sub` in production, a mock value in Phase 1. It is the only field
 * the API trusts from a token; role and family always come from `familyMembers`.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authSubject: text("auth_subject").notNull(),
    email: text("email"),
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("users_auth_subject_key").on(table.authSubject)],
);

export const families = pgTable("families", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("AUD"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Membership is the authorisation record: role and family scope are read from
 * here, never from a request body or token claim.
 *
 * `userId` is nullable because a parent adds a child before that child has
 * signed in — the member exists, holds a join code, and is bound to a user only
 * when the code is redeemed.
 *
 * Avatar fields store identifiers, never asset URLs, so the catalog can be
 * re-skinned or re-hosted without touching member rows.
 */
export const familyMembers = pgTable(
  "family_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    role: familyRole("role").notNull(),
    status: memberStatus("status").notNull().default("invited"),
    displayName: text("display_name").notNull(),
    dateOfBirth: date("date_of_birth"),

    avatarMascotId: text("avatar_mascot_id"),
    avatarStyle: avatarStyle("avatar_style"),
    avatarVersion: integer("avatar_version"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("family_members_family_idx").on(table.familyId),
    // One membership per user per family. Partial, because unbound child slots
    // all carry a null userId and must not collide with one another.
    uniqueIndex("family_members_family_user_key")
      .on(table.familyId, table.userId)
      .where(sql`${table.userId} is not null`),
  ],
);

/**
 * A one-time code that binds a signing-in user to an existing child member.
 * Single-use: `redeemedAt` and `redeemedByUserId` are set together.
 */
export const joinCodes = pgTable(
  "join_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedByUserId: uuid("redeemed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Only live codes must be unique; spent ones are kept for audit.
    uniqueIndex("join_codes_code_active_key")
      .on(table.code)
      .where(sql`${table.redeemedAt} is null`),
    index("join_codes_member_idx").on(table.memberId),
  ],
);
