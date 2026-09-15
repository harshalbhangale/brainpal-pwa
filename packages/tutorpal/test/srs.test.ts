import assert from "node:assert/strict";
import { test } from "node:test";

import { schedule } from "../dist/index.js";

const NOW = new Date("2026-09-15T00:00:00Z");
const fresh = { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0 };
const days = (d: Date) => Math.round((d.getTime() - NOW.getTime()) / 86_400_000);

test("a new card answered well comes back in 1 day, then 3, then grows by its ease", () => {
  const first = schedule(fresh, "good", NOW);
  assert.equal(first.intervalDays, 1);
  assert.equal(days(first.dueAt), 1);
  const second = schedule(first, "good", NOW);
  assert.equal(second.intervalDays, 3);
  const third = schedule(second, "good", NOW);
  assert.equal(third.intervalDays, 8);
  assert.equal(third.state, "review");
});

test("'again' brings it back in ten minutes and makes it easier to forget", () => {
  const learned = schedule(schedule(fresh, "good", NOW), "good", NOW);
  const missed = schedule(learned, "again", NOW);
  assert.equal(missed.reps, 0);
  assert.equal(missed.lapses, 1);
  assert.equal(missed.state, "learning");
  assert.equal(missed.dueAt.getTime() - NOW.getTime(), 10 * 60 * 1000);
  assert.ok(missed.ease < learned.ease);
});

test("ease never drops below its floor", () => {
  let card = { ...fresh };
  for (let i = 0; i < 20; i++) card = schedule(card, "again", NOW);
  assert.equal(card.ease, 1.3);
});

test("a card that keeps being known graduates", () => {
  let card: ReturnType<typeof schedule> = schedule(fresh, "easy", NOW);
  while (card.state !== "known") card = schedule(card, "easy", NOW);
  assert.ok(card.intervalDays >= 21);
});
