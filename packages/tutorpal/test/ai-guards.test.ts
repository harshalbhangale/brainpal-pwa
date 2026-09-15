import assert from "node:assert/strict";
import { test } from "node:test";

import { givesAway, revealsAnswer } from "../dist/ai.js";

const QUESTION = "What happens when the call stack is empty and a callback is waiting in the queue?";
const ANSWER = "The event loop takes the callback from the queue and pushes it onto the stack to run.";

test("feedback that explains the answer in other words is caught", () => {
  assert.equal(
    revealsAnswer("Not quite. The event loop does not stop — it takes the waiting callback and pushes it onto the stack so it can run.", ANSWER, QUESTION),
    true,
  );
});

test("a nudge may repeat the question's words without counting as the answer", () => {
  assert.equal(revealsAnswer("Think about what the event loop does when the stack is empty.", ANSWER, QUESTION), false);
  assert.equal(revealsAnswer("Nothing stops. Look at what waits in the queue.", ANSWER, QUESTION), false);
});

test("a hint that states the answer is caught, whatever the case or punctuation", () => {
  assert.equal(givesAway("The capital is Canberra, so choose Canberra.", "Canberra"), true);
  assert.equal(givesAway("Australia has six states, so the answer is six.", "six"), true);
  assert.equal(givesAway("It is in the Australian Capital Territory!", "the Australian Capital Territory"), true);
  assert.equal(givesAway("7 x 8 = 56", "56"), true);
});

test("a hint that only nudges is left alone", () => {
  assert.equal(givesAway("Think about where Parliament House is.", "Canberra"), false);
  assert.equal(givesAway("Count the states in the list.", "six"), false);
  // Whole words only: "56" is not hiding inside "156".
  assert.equal(givesAway("Try 156 divided by something smaller.", "56"), false);
  // One-letter answers (an option label, "a") are too short to judge.
  assert.equal(givesAway("a good place to start is the list", "a"), false);
});
