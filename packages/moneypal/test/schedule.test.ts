import assert from "node:assert/strict";
import { test } from "node:test";

import { MoneyError, localDateKey, nextAllowanceAt, weeklyPathMinor } from "../dist/index.js";

const SYDNEY = "Australia/Sydney";
const FRIDAY = 5;

test("the next Friday allowance lands at 7am Sydney time", () => {
  // Wednesday 16 Sep 2026, 10am in Sydney (AEST, UTC+10).
  const at = nextAllowanceAt(new Date("2026-09-16T00:00:00Z"), FRIDAY, SYDNEY);
  assert.equal(at.toISOString(), "2026-09-17T21:00:00.000Z");
  assert.equal(localDateKey(at, SYDNEY), "2026-09-18");
});

test("it follows daylight saving across the change", () => {
  // Sydney moves to AEDT (UTC+11) on Sunday 4 Oct 2026.
  const before = nextAllowanceAt(new Date("2026-10-01T00:00:00Z"), FRIDAY, SYDNEY);
  assert.equal(before.toISOString(), "2026-10-01T21:00:00.000Z");
  const after = nextAllowanceAt(before, FRIDAY, SYDNEY);
  assert.equal(after.toISOString(), "2026-10-08T20:00:00.000Z", "still 7am local, one hour earlier in UTC");
});

test("the same day counts only if 7am has not passed yet", () => {
  const sixAm = new Date("2026-09-17T20:00:00Z"); // Friday 6am Sydney
  assert.equal(nextAllowanceAt(sixAm, FRIDAY, SYDNEY).toISOString(), "2026-09-17T21:00:00.000Z");
  const eightAm = new Date("2026-09-17T22:00:00Z"); // Friday 8am Sydney
  assert.equal(nextAllowanceAt(eightAm, FRIDAY, SYDNEY).toISOString(), "2026-09-24T21:00:00.000Z");
});

test("an unknown time zone is refused", () => {
  assert.throws(
    () => nextAllowanceAt(new Date(), FRIDAY, "Mars/Olympus"),
    (e: unknown) => e instanceof MoneyError && e.code === "INVALID_TIMEZONE",
  );
});

test("the weekly path spreads what is left over the weeks remaining", () => {
  const today = new Date("2026-09-15T12:00:00Z");
  assert.equal(weeklyPathMinor(50_00, 2_00, "2026-11-24", today), 4_80);
  assert.equal(weeklyPathMinor(50_00, 60_00, "2026-11-24", today), 0);
  assert.equal(weeklyPathMinor(50_00, 0, null, today), null);
  assert.equal(weeklyPathMinor(10_00, 0, "2026-09-01", today), 10_00, "a past date asks for it all now");
});
