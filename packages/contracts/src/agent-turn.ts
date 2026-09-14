import { z } from "zod";
import { CommandProposal } from "./commands.js";
import { OwningPalId } from "./pals.js";

/**
 * The contract every agent turn is held to. The orchestrator, both PALs and the
 * web client all type against this, so it is versioned from the first commit:
 * Phase 4 introduces PAL-to-PAL handoffs that must be able to reject a payload
 * written by an older agent rather than silently misread it.
 */
export const CONTRACT_VERSION = "1" as const;

export const ResponseType = z.enum([
  "message",
  "question",
  "proposal",
  "progress",
  "error",
]);
export type ResponseType = z.infer<typeof ResponseType>;

export const AgentTurnResult = z
  .object({
    version: z.literal(CONTRACT_VERSION),
    ownerPal: OwningPalId,
    intent: z.string().min(1).max(120),
    responseType: ResponseType,
    message: z.string(),
    requiresConfirmation: z.boolean(),
    threadId: z.uuid().optional(),
    proposal: CommandProposal.optional(),
  })
  .refine(
    (turn) => turn.responseType !== "proposal" || turn.proposal !== undefined,
    { error: "a proposal turn must carry a proposal", path: ["proposal"] },
  )
  .refine((turn) => turn.proposal === undefined || turn.requiresConfirmation, {
    error: "a proposal always requires confirmation before execution",
    path: ["requiresConfirmation"],
  });

export type AgentTurnResult = z.infer<typeof AgentTurnResult>;

export const AgentTurnRequest = z.object({
  text: z.string().min(1).max(4000),
  threadId: z.uuid().optional(),
});
export type AgentTurnRequest = z.infer<typeof AgentTurnRequest>;
