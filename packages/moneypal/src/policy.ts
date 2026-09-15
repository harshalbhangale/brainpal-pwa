import type { MoneyCommand } from "@brainpal/contracts";

export type Role = "parent" | "co_guardian" | "child";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "require_approval" }
  | { type: "deny"; code: string; message: string };

export function isParentRole(role: Role): boolean {
  return role === "parent" || role === "co_guardian";
}

const ALLOW: PolicyDecision = { type: "allow" };

/**
 * A parent's own request is its own confirmation. A child may act on their own
 * things — submit work, set a goal, move money into Save, freeze their card —
 * but anything that brings money out or changes a rule is a parent's call.
 * Whether a child is acting on *themselves* is checked in the engine, which
 * can see the family.
 */
export function policyFor(role: Role, proposal: MoneyCommand): PolicyDecision {
  const parent = isParentRole(role);
  switch (proposal.command) {
    case "spend.request":
      return parent
        ? {
            type: "deny",
            code: "CHILD_ONLY",
            message: "Spend requests come from a child. As a parent you can send money directly.",
          }
        : ALLOW;
    case "chore.submit":
    case "savings.goal.create":
      return ALLOW;
    case "savings.move":
      return parent || proposal.payload.direction === "to_save" ? ALLOW : { type: "require_approval" };
    case "card.freeze":
      return parent || proposal.payload.frozen
        ? ALLOW
        : { type: "deny", code: "CHILD_CANNOT_UNFREEZE", message: "Only a parent can unfreeze a card." };
    default:
      return parent
        ? ALLOW
        : {
            type: "deny",
            code: "CHILD_CANNOT_MOVE_MONEY",
            message: "Only a parent can move money. You can finish a chore or ask a parent instead.",
          };
  }
}
