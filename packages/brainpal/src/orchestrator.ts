import {
  type AgentTurnResult,
  CONTRACT_VERSION,
  type FamilyRole,
  type OwningPalId,
} from "@brainpal/contracts";

import { agentFor } from "./agents.js";
import { type ModelRole, modelNameFor } from "./models.js";
import { applyActivation, routeRequest } from "./router.js";

export interface TurnInput {
  text: string;
  speakerName: string;
  speakerRole: FamilyRole;
  /** PAL ids this family has activated. An inactive PAL cannot own a request. */
  activePals: ReadonlySet<string>;
}

export type TurnEvent =
  | { type: "routed"; ownerPal: OwningPalId; intent: string; confidence: number }
  | { type: "delta"; text: string }
  | { type: "done"; result: AgentTurnResult; usage: TurnUsage }
  | { type: "error"; code: string; message: string };

export interface TurnUsage {
  /** The role the model was addressed by. */
  modelRole: ModelRole;
  /** The model that actually ran — the id, never the agent's name. */
  model: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  latencyMs: number;
}

/**
 * One request, one owning PAL.
 *
 * Deliberately knows nothing about the database. The caller owns persistence,
 * which keeps this whole package testable without one and stops thread-writing
 * from being tangled into routing.
 *
 * Phase 1 stops at a single owner. PAL-to-PAL handoffs are Phase 4 and belong
 * here, after this single-owner path is stable.
 */
export async function* runTurn(
  input: TurnInput,
): AsyncGenerator<TurnEvent, void, undefined> {
  const startedAt = Date.now();

  let routing;
  try {
    routing = applyActivation(await routeRequest(input.text), input.activePals);
  } catch (error) {
    yield {
      type: "error",
      code: "ROUTING_FAILED",
      message: error instanceof Error ? error.message : "could not route",
    };
    return;
  }

  yield {
    type: "routed",
    ownerPal: routing.ownerPal,
    intent: routing.intent,
    confidence: routing.confidence,
  };

  const agent = agentFor(routing.ownerPal);
  const context = `You are speaking with ${input.speakerName}, who is a ${
    input.speakerRole === "child" ? "child" : "parent"
  } in this family.`;

  const PAL_ROLE: ModelRole = "balanced";

  let text = "";
  let usage: TurnUsage = {
    modelRole: PAL_ROLE,
    model: modelNameFor(PAL_ROLE),
    inputTokens: undefined,
    outputTokens: undefined,
    latencyMs: 0,
  };

  try {
    const stream = await agent.stream([
      { role: "system", content: context },
      { role: "user", content: input.text },
    ]);

    for await (const delta of stream.textStream) {
      text += delta;
      yield { type: "delta", text: delta };
    }

    const counts = await stream.usage;
    usage = {
      modelRole: PAL_ROLE,
      model: modelNameFor(PAL_ROLE),
      inputTokens: counts?.inputTokens,
      outputTokens: counts?.outputTokens,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    yield {
      type: "error",
      code: "PAL_FAILED",
      message: error instanceof Error ? error.message : "the PAL failed",
    };
    return;
  }

  const result: AgentTurnResult = {
    version: CONTRACT_VERSION,
    ownerPal: routing.ownerPal,
    intent: routing.intent,
    responseType: "message",
    message: text,
    requiresConfirmation: false,
  };

  yield { type: "done", result, usage };
}
