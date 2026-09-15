import { OwningPalId } from "@brainpal/contracts";
import { generateObject } from "ai";
import { z } from "zod";

import { modelFor } from "./models.js";

export const RoutingDecision = z.object({
  ownerPal: OwningPalId,
  intent: z
    .string()
    .describe("a short dotted slug, e.g. savings.explain or quiz.create"),
  confidence: z.number().min(0).max(1),
});
export type RoutingDecision = z.infer<typeof RoutingDecision>;

const SYSTEM = `You route a family request to exactly one PAL.

moneypal — money: balances and how much money someone has, the family
wallet, saving, spending, pocket money, allowance, chores and what they pay,
approvals and anything waiting for a parent, spend requests, cards, savings
goals and progress towards them, affordability, prices.
tutorpal — learning: homework, subjects, revision, flashcards, quizzes,
explaining a topic, exam practice, study plans.
brainpal — anything else: greetings, app questions, family or account setup,
and requests that belong to no single PAL.

Choose the PAL that owns the OUTCOME, not one merely mentioned. "Give Maya
pocket money when she finishes her maths" is owned by moneypal: the outcome is
a payment. "Help Maya revise maths so she earns her pocket money" is owned by
tutorpal: the outcome is learning.

"How much money do I have?", "Is anything waiting for me to approve?" and
"How close am I to my bike?" are all moneypal: they are about this family's
money, even though they name no amount.

Only when a request truly belongs to no PAL, or could equally be either,
prefer brainpal and ask a question rather than guessing. Confidence below 0.6
means you are unsure.`;

/**
 * Routing is a structured-output call, not prose that gets parsed: the model is
 * constrained to the schema, so an unroutable answer fails here rather than
 * downstream.
 */
export async function routeRequest(text: string): Promise<RoutingDecision> {
  const { object } = await generateObject({
    model: modelFor("router"),
    schema: RoutingDecision,
    system: SYSTEM,
    prompt: text,
  });
  return object;
}

/** A PAL a family has not activated cannot own a request. */
export function applyActivation(
  decision: RoutingDecision,
  activePals: ReadonlySet<string>,
): RoutingDecision {
  if (decision.ownerPal === "brainpal") return decision;
  if (activePals.has(decision.ownerPal)) return decision;
  return { ...decision, ownerPal: "brainpal", intent: "pal.not_activated" };
}
