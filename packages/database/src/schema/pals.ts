import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { families } from "./identity.js";
import { palId } from "./enums.js";

/** The catalog of PALs the product knows about. Seeded, not user-writable. */
export const palRegistry = pgTable("pal_registry", {
  id: palId("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  available: boolean("available").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Per-family activation. MoneyPAL and TutorPAL activate independently, so the
 * orchestrator can refuse to route to a PAL a family has not turned on.
 * `level` tracks that PAL's own setup progress, separate from core onboarding.
 */
export const palActivations = pgTable(
  "pal_activations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    palId: palId("pal_id")
      .notNull()
      .references(() => palRegistry.id),
    active: boolean("active").notNull().default(false),
    level: integer("level").notNull().default(0),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("pal_activations_family_pal_key").on(
      table.familyId,
      table.palId,
    ),
  ],
);
