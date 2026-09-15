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
    /** The creating parent's own name — not the family's. */
    parentName: z.string().min(1).max(40),
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

/** Integer minor units (cents). $10,000 caps a single movement. */
const AmountMinor = z.number().int().min(1).max(1_000_000);
const Destination = z.enum(["spend", "save"]);

export const WalletTopup = z.object({
  command: z.literal("wallet.topup"),
  payload: z.object({
    amountMinor: AmountMinor,
    title: z.string().min(1).max(200),
  }),
});

export const MoneyTransfer = z.object({
  command: z.literal("money.transfer"),
  payload: z.object({
    childMemberId: z.uuid(),
    destination: Destination,
    amountMinor: AmountMinor,
    title: z.string().min(1).max(200),
  }),
});

export const ChoreAssign = z.object({
  command: z.literal("chore.assign"),
  payload: z.object({
    childMemberId: z.uuid(),
    title: z.string().min(1).max(200),
    detail: z.string().max(500).optional(),
    rewardMinor: z.number().int().min(0).max(100_000),
    destination: Destination,
  }),
});

export const ChoreSubmit = z.object({
  command: z.literal("chore.submit"),
  payload: z.object({ choreId: z.uuid() }),
});

/** The money commands a client may send. `chore.pay` is not here: only the engine creates it. */
export const MoneyCommand = z.discriminatedUnion("command", [
  WalletTopup,
  MoneyTransfer,
  ChoreAssign,
  ChoreSubmit,
]);
export type MoneyCommand = z.infer<typeof MoneyCommand>;

export const CommandProposal = z.discriminatedUnion("command", [
  FamilyCreate,
  ChildAdd,
  AvatarSelect,
  WalletTopup,
  MoneyTransfer,
  ChoreAssign,
  ChoreSubmit,
]);
export type CommandProposal = z.infer<typeof CommandProposal>;

export const CommandKind = z.enum([
  "family.create",
  "child.add",
  "avatar.select",
  "wallet.topup",
  "money.transfer",
  "chore.assign",
  "chore.submit",
]);
export type CommandKind = z.infer<typeof CommandKind>;
