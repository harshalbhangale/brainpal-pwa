import { z } from "zod";

export const PalId = z.enum(["brainpal", "moneypal", "tutorpal"]);
export type PalId = z.infer<typeof PalId>;

/** PALs a request can be handed to. BrainPal routes; it does not own outcomes. */
export const OwningPalId = z.enum(["brainpal", "moneypal", "tutorpal"]);
export type OwningPalId = z.infer<typeof OwningPalId>;

export const FamilyRole = z.enum(["parent", "co_guardian", "child"]);
export type FamilyRole = z.infer<typeof FamilyRole>;
