import { MoneyError } from "./errors.js";

const DAY_MS = 86_400_000;
const HALF_DAY_MS = DAY_MS / 2;

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone }).format(0);
  } catch {
    throw new MoneyError("INVALID_TIMEZONE", `${timeZone} is not a time zone`);
  }
}

function localParts(date: Date, timeZone: string) {
  const out: Record<string, number> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  for (const part of format.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

function offsetAt(instant: number, timeZone: string): number {
  const p = localParts(new Date(instant), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
}

/**
 * The instant a local wall-clock time occurs in `timeZone`. Two passes, because
 * the offset at the first guess can sit on the other side of a daylight-saving
 * change from the answer.
 */
function zonedInstant(year: number, month: number, day: number, hour: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour);
  const first = guess - offsetAt(guess, timeZone);
  return new Date(guess - offsetAt(first, timeZone));
}

/** Midnight at the start of `date`'s local day in `timeZone`. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const p = localParts(date, timeZone);
  return zonedInstant(p.year, p.month, p.day, 0, timeZone);
}

export function localDateKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * The next moment strictly after `from` that is `weekday` (0 = Sunday) at
 * `hour` o'clock in the family's own time zone. Probes in half-day steps so a
 * 23-hour daylight-saving day can never skip a date.
 */
export function nextAllowanceAt(from: Date, weekday: number, timeZone: string, hour = 7): Date {
  assertTimeZone(timeZone);
  for (let i = 0; i <= 16; i++) {
    const p = localParts(new Date(from.getTime() + i * HALF_DAY_MS), timeZone);
    if (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() !== weekday) continue;
    const at = zonedInstant(p.year, p.month, p.day, hour, timeZone);
    if (at.getTime() > from.getTime()) return at;
  }
  throw new MoneyError("SCHEDULE_UNRESOLVED", "could not work out the next allowance date");
}

/** How much a week reaches the goal by its date. Null when the goal has no date. */
export function weeklyPathMinor(
  targetMinor: number,
  savedMinor: number,
  targetDate: string | null,
  today = new Date(),
): number | null {
  if (!targetDate) return null;
  const remaining = Math.max(0, targetMinor - savedMinor);
  if (remaining === 0) return 0;
  const days = (Date.parse(`${targetDate}T00:00:00Z`) - today.getTime()) / DAY_MS;
  const weeks = Math.max(1, Math.ceil(days / 7));
  return Math.ceil(remaining / weeks);
}
