import { createOpenAI } from "@ai-sdk/openai";

/**
 * Models are addressed by the job they do, never by name. Routing and
 * extraction want something small and fast; teaching wants something strong.
 * Changing that balance — or the provider — is an environment change, not a
 * code change, which is what "provider-neutral routing" has to mean in practice.
 */
export const MODEL_ROLES = [
  "router",
  "balanced",
  "reasoning",
  "vision",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

const ENV_BY_ROLE: Record<ModelRole, string> = {
  router: "MODEL_ROUTER",
  balanced: "MODEL_BALANCED",
  reasoning: "MODEL_REASONING",
  vision: "MODEL_VISION",
};

export function modelNameFor(role: ModelRole): string {
  const name = process.env[ENV_BY_ROLE[role]];
  if (!name) {
    throw new Error(
      `${ENV_BY_ROLE[role]} is not set. Every model is addressed by role; ` +
        `see .env.example.`,
    );
  }
  return name;
}

let provider: ReturnType<typeof createOpenAI> | undefined;

function getProvider() {
  if (!provider) {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
    provider = createOpenAI({ apiKey });
  }
  return provider;
}

/** Named explicitly: the provider's model type is not portable by inference. */
export type BrainPalModel = ReturnType<ReturnType<typeof createOpenAI>>;

export function modelFor(role: ModelRole): BrainPalModel {
  return getProvider()(modelNameFor(role));
}

/** True when the model layer is usable. Lets the API fall back rather than 500. */
export function modelsConfigured(): boolean {
  if (!process.env["OPENAI_API_KEY"]) return false;
  return MODEL_ROLES.every((role) => Boolean(process.env[ENV_BY_ROLE[role]]));
}
