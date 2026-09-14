import { z } from "zod";
import { AvatarSelection } from "./avatar.js";

/**
 * Every consequential action a PAL can propose. A PAL never executes: it emits
 * one of these, Trust validates it, a human confirms it, and a deterministic
 * engine runs it.
 *
 * Discriminated on `command` rather than a loose record so that Phase 4's
 * PAL-to-PAL handoffs can be validated structurally at the boundary. Each phase
 * adds its own members: Phase 2 the money commands, Phase 3 the learning ones.
 */

export const FamilyCreate = z.object({
  command: z.literal("family.create"),
  payload: z.object({
    familyName: z.string().min(1).max(80),
    currency: z.literal("AUD"),
  }),
});

export const ChildAdd = z.object({
  command: z.literal("child.add"),
  payload: z.object({
    displayName: z.string().min(1).max(40),
    dateOfBirth: z.iso.date().optional(),
  }),
});

export const AvatarSelect = z.object({
  command: z.literal("avatar.select"),
  payload: z.object({
    memberId: z.uuid(),
    selection: AvatarSelection,
  }),
});

export const CommandProposal = z.discriminatedUnion("command", [
  FamilyCreate,
  ChildAdd,
  AvatarSelect,
]);
export type CommandProposal = z.infer<typeof CommandProposal>;

export const CommandKind = z.enum([
  "family.create",
  "child.add",
  "avatar.select",
]);
export type CommandKind = z.infer<typeof CommandKind>;
