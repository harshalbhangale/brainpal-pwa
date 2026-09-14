import assert from "node:assert/strict";
import { test } from "node:test";

import { applyActivation, modelsConfigured } from "../dist/index.js";

const decision = { ownerPal: "moneypal", intent: "savings.explain", confidence: 0.9 } as const;

test("an activated PAL keeps ownership", () => {
  const result = applyActivation(decision, new Set(["moneypal"]));
  assert.equal(result.ownerPal, "moneypal");
  assert.equal(result.intent, "savings.explain");
});

test("a PAL the family has not activated cannot own a request", () => {
  const result = applyActivation(decision, new Set(["tutorpal"]));
  assert.equal(result.ownerPal, "brainpal");
  assert.equal(result.intent, "pal.not_activated");
});

test("BrainPal needs no activation", () => {
  const result = applyActivation(
    { ownerPal: "brainpal", intent: "greeting", confidence: 1 },
    new Set(),
  );
  assert.equal(result.ownerPal, "brainpal");
});

test("the model layer reports itself unconfigured when a role is missing", () => {
  const saved = { ...process.env };
  try {
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["MODEL_ROUTER"] = "a";
    process.env["MODEL_BALANCED"] = "b";
    process.env["MODEL_REASONING"] = "c";
    delete process.env["MODEL_VISION"];
    assert.equal(modelsConfigured(), false);

    process.env["MODEL_VISION"] = "d";
    assert.equal(modelsConfigured(), true);
  } finally {
    process.env = saved;
  }
});
