import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { actorType, palId, responseType, runStatus } from "./enums.js";
import { families, familyMembers } from "./identity.js";

/**
 * One request, one thread. Every step of a turn — including the cross-PAL
 * handoffs Phase 4 introduces — belongs to exactly one thread, so a parent can
 * always see the whole story in one place.
 *
 * `subjectMemberId` is the child a thread is *about*, which is what scopes
 * visibility. It is not the same as the member who started it.
 */
export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    subjectMemberId: uuid("subject_member_id").references(
      () => familyMembers.id,
      { onDelete: "set null" },
    ),
    ownerPal: palId("owner_pal").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("threads_family_updated_idx").on(table.familyId, table.updatedAt),
    index("threads_subject_idx").on(table.subjectMemberId),
  ],
);

/** Append-only. Events are never mutated, so a thread reads as what happened. */
export const threadEvents = pgTable(
  "thread_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    actorType: actorType("actor_type").notNull(),
    actorMemberId: uuid("actor_member_id").references(() => familyMembers.id, {
      onDelete: "set null",
    }),
    actorPal: palId("actor_pal"),
    kind: text("kind").notNull(),
    body: text("body"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("thread_events_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
  ],
);

/**
 * One row per agent turn. This is the observability spine the build plan asks
 * for: who requested it, which PAL owned it, which model ran, what it cost and
 * how long it took.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
    actorMemberId: uuid("actor_member_id").references(() => familyMembers.id, {
      onDelete: "set null",
    }),

    contractVersion: text("contract_version").notNull(),
    inputText: text("input_text").notNull(),
    ownerPal: palId("owner_pal"),
    intent: text("intent"),
    responseType: responseType("response_type"),

    modelRole: text("model_role"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),

    status: runStatus("status").notNull().default("running"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_runs_family_created_idx").on(table.familyId, table.createdAt),
    index("agent_runs_thread_idx").on(table.threadId),
  ],
);

/**
 * Append-only record of consequential actions and policy decisions. Separate
 * from `threadEvents`: a thread is what the family sees, this is what the
 * system can be held to.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    actorMemberId: uuid("actor_member_id").references(() => familyMembers.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    runId: uuid("run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_events_family_created_idx").on(
      table.familyId,
      table.createdAt,
    ),
    index("audit_events_resource_idx").on(table.resourceType, table.resourceId),
  ],
);
