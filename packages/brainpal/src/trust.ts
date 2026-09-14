import type { CommandProposal, FamilyRole } from "@brainpal/contracts";

/**
 * The seam every consequential action passes through. Phase 1 has no commands
 * to police, so the only rule here is the one that must never be optional: a
 * proposal is never self-approving.
 *
 * This graduates to its own package when it holds real policy — Phase 2, where
 * money rules, per-child limits and approval thresholds arrive. Standing it up
 * as an empty package now would be ceremony, but the seam has to exist from the
 * first turn so no route is written that bypasses it.
 */

export type TrustDecision =
  | { outcome: "allow" }
  | { outcome: "require_approval"; reason: string }
  | { outcome: "deny"; code: string; reason: string };

export interface TrustContext {
  role: FamilyRole;
  familyId: string;
  memberId: string;
}

export function checkProposal(
  context: TrustContext,
  proposal: CommandProposal,
): TrustDecision {
  // A child may ask for anything and decide nothing.
  if (context.role === "child") {
    return {
      outcome: "require_approval",
      reason: `${proposal.command} needs a parent`,
    };
  }
  return { outcome: "require_approval", reason: "consequential action" };
}
