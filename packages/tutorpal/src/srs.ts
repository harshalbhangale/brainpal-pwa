export type Grade = "again" | "hard" | "good" | "easy";

export interface CardSchedule {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
}

export interface Scheduled extends CardSchedule {
  state: "learning" | "review" | "known";
  dueAt: Date;
}

const DAY_MS = 86_400_000;
const RELEARN_MS = 10 * 60 * 1000;
const MIN_EASE = 1.3;
const KNOWN_AFTER_DAYS = 21;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A simplified SM-2. A card answered well comes back after 1, then 3 days,
 * then its interval grows by its ease. "Again" puts it back in ten minutes and
 * makes it come round more often from then on.
 */
export function schedule(card: CardSchedule, grade: Grade, now: Date): Scheduled {
  let { ease, intervalDays, reps } = card;
  let { lapses } = card;

  if (grade === "again") {
    return {
      ease: round2(Math.max(MIN_EASE, ease - 0.2)),
      intervalDays: 0,
      reps: 0,
      lapses: lapses + 1,
      state: "learning",
      dueAt: new Date(now.getTime() + RELEARN_MS),
    };
  }

  if (grade === "hard") {
    intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
    ease = Math.max(MIN_EASE, ease - 0.15);
  } else if (grade === "good") {
    intervalDays = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(intervalDays * ease);
  } else {
    intervalDays = reps === 0 ? 3 : Math.round(Math.max(intervalDays, 1) * ease * 1.3);
    ease += 0.15;
  }

  return {
    ease: round2(ease),
    intervalDays,
    reps: reps + 1,
    lapses,
    state: intervalDays >= KNOWN_AFTER_DAYS ? "known" : "review",
    dueAt: new Date(now.getTime() + intervalDays * DAY_MS),
  };
}
