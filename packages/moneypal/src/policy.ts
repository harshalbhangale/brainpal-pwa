import type { MoneyCommand } from "@brainpal/contracts";

export type Role = "parent" | "co_guardian" | "child";

export type PolicyDecision =
  | { type: "allow" }
  | { type: "deny"; code: string; message: string };

export function isParentRole(role: Role): boolean {
  return role === "parent" || role === "co_guardian";
}

/**
 * A parent's own request is its own confirmation. A child may only submit work
 * for review; anything that moves money is a parent's call.
 */
export function policyFor(role: Role, command: MoneyCommand["command"]): PolicyDecision {
  if (isParentRole(role)) return { type: "allow" };
  if (command === "chore.submit") return { type: "allow" };
  return {
    type: "deny",
    code: "CHILD_CANNOT_MOVE_MONEY",
    message: "Only a parent can move money. You can finish a chore or ask a parent instead.",
  };
}
