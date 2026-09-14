import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentTurnResult, CommandProposal, CONTRACT_VERSION } from "../dist/index.js";

const message = {
  version: CONTRACT_VERSION,
  ownerPal: "moneypal",
  intent: "savings.explain",
  responseType: "message",
  message: "Maya could put $4 a week aside.",
  requiresConfirmation: false,
} as const;

test("a plain message turn round-trips", () => {
  const parsed = AgentTurnResult.parse(message);
  assert.equal(parsed.ownerPal, "moneypal");
  assert.equal(parsed.proposal, undefined);
});

test("an unknown owning PAL is rejected", () => {
  assert.equal(
    AgentTurnResult.safeParse({ ...message, ownerPal: "shoppal" }).success,
    false,
  );
});

test("a turn from an unknown contract version is rejected", () => {
  assert.equal(
    AgentTurnResult.safeParse({ ...message, version: "0" }).success,
    false,
  );
});

test("a proposal turn without a proposal is rejected", () => {
  const result = AgentTurnResult.safeParse({
    ...message,
    responseType: "proposal",
    requiresConfirmation: true,
  });
  assert.equal(result.success, false);
});

test("a proposal can never skip confirmation", () => {
  const result = AgentTurnResult.safeParse({
    ...message,
    responseType: "proposal",
    requiresConfirmation: false,
    proposal: {
      command: "child.add",
      payload: { displayName: "Maya" },
    },
  });
  assert.equal(result.success, false);
});

test("a well-formed proposal turn is accepted", () => {
  const parsed = AgentTurnResult.parse({
    ...message,
    responseType: "proposal",
    requiresConfirmation: true,
    proposal: {
      command: "child.add",
      payload: { displayName: "Maya", dateOfBirth: "2016-04-02" },
    },
  });
  assert.equal(parsed.proposal?.command, "child.add");
});

test("the proposal union discriminates on command", () => {
  const result = CommandProposal.safeParse({
    command: "avatar.select",
    payload: { displayName: "Maya" },
  });
  assert.equal(result.success, false);
});
