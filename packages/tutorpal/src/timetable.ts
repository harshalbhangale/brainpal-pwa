import { type Database, classSessions, subjects } from "@brainpal/database";
import { and, eq } from "drizzle-orm";

import { type Actor, assertVisible, notFound, subjectFor } from "./access.js";
import { TutorError } from "./errors.js";
import { getProfile } from "./service.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function updateSubject(
  db: Database,
  actor: Actor,
  subjectId: string,
  input: { nextExamDate: string | null },
) {
  const subject = await subjectFor(db, actor, subjectId);
  await db.update(subjects).set({ nextExamDate: input.nextExamDate }).where(eq(subjects.id, subject.id));
  return getProfile(db, actor, subject.memberId);
}

/** Its classes go with it; material filed under it stays, just unfiled. */
export async function removeSubject(db: Database, actor: Actor, subjectId: string) {
  const subject = await subjectFor(db, actor, subjectId);
  await db.delete(subjects).where(eq(subjects.id, subject.id));
  return getProfile(db, actor, subject.memberId);
}

export async function addClass(
  db: Database,
  actor: Actor,
  subjectId: string,
  input: { weekday: number; startsAt: string; endsAt: string; location?: string | undefined },
) {
  const subject = await subjectFor(db, actor, subjectId);
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    throw new TutorError("INVALID_TIMES", "Pick a day of the week.");
  }
  if (!TIME.test(input.startsAt) || !TIME.test(input.endsAt) || input.endsAt <= input.startsAt) {
    throw new TutorError("INVALID_TIMES", "A class has to end after it starts.");
  }
  await db.insert(classSessions).values({
    familyId: actor.familyId,
    memberId: subject.memberId,
    subjectId: subject.id,
    weekday: input.weekday,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    location: input.location?.trim() || null,
  });
  return getProfile(db, actor, subject.memberId);
}

export async function removeClass(db: Database, actor: Actor, classId: string) {
  const [row] = await db
    .select()
    .from(classSessions)
    .where(and(eq(classSessions.id, classId), eq(classSessions.familyId, actor.familyId)))
    .limit(1);
  if (!row) throw notFound();
  assertVisible(actor, row.memberId);
  await db.delete(classSessions).where(eq(classSessions.id, row.id));
  return getProfile(db, actor, row.memberId);
}
