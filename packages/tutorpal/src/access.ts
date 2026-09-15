import {
  type Database,
  type NextStep,
  documentSections,
  familyMembers,
  learningDocuments,
  learningEvidence,
  learningProgress,
  learningSources,
  subjects,
} from "@brainpal/database";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

import { TutorError } from "./errors.js";

export type Role = "parent" | "co_guardian" | "child";

export interface Actor {
  memberId: string;
  familyId: string;
  role: Role;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const isParent = (actor: Actor) => actor.role === "parent" || actor.role === "co_guardian";
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export const notFound = () => new TutorError("NOT_FOUND", "That was not found.");

/**
 * A parent sees every child's material; a child sees only their own. Refusal
 * reads exactly like absence, so one child cannot learn another's ids exist.
 */
export function assertVisible(actor: Actor, ownerMemberId: string): void {
  if (!isParent(actor) && actor.memberId !== ownerMemberId) throw notFound();
}

/** Attempts and reviews are evidence of the child's own learning, so only they can make them. */
export function assertOwner(actor: Actor, ownerMemberId: string, what: string): void {
  if (actor.memberId !== ownerMemberId) {
    throw new TutorError("CHILD_ONLY", `${what} count towards the child's own learning, so only they can do it.`);
  }
}

export async function childOf(db: Database, familyId: string, memberId: string) {
  const [child] = await db
    .select({ id: familyMembers.id, displayName: familyMembers.displayName })
    .from(familyMembers)
    .where(
      and(
        eq(familyMembers.id, memberId),
        eq(familyMembers.familyId, familyId),
        eq(familyMembers.role, "child"),
        ne(familyMembers.status, "removed"),
      ),
    )
    .limit(1);
  if (!child) throw new TutorError("NOT_FOUND", "That child is not in this family.");
  return child;
}

/** A subject must belong to the same child as the thing being filed under it. */
export async function subjectFor(db: Database, actor: Actor, subjectId: string, memberId?: string) {
  const [subject] = await db
    .select()
    .from(subjects)
    .where(and(eq(subjects.id, subjectId), eq(subjects.familyId, actor.familyId)))
    .limit(1);
  if (!subject || (memberId && subject.memberId !== memberId)) throw notFound();
  assertVisible(actor, subject.memberId);
  return subject;
}

export async function sourceFor(db: Database, actor: Actor, sourceId: string) {
  const [source] = await db
    .select()
    .from(learningSources)
    .where(and(eq(learningSources.id, sourceId), eq(learningSources.familyId, actor.familyId)))
    .limit(1);
  if (!source) throw notFound();
  assertVisible(actor, source.ownerMemberId);
  return source;
}

export async function documentFor(db: Database, actor: Actor, documentId: string) {
  const [row] = await db
    .select({ doc: learningDocuments, source: learningSources })
    .from(learningDocuments)
    .innerJoin(learningSources, eq(learningSources.id, learningDocuments.sourceId))
    .where(and(eq(learningDocuments.id, documentId), eq(learningDocuments.familyId, actor.familyId)))
    .limit(1);
  if (!row) throw notFound();
  assertVisible(actor, row.source.ownerMemberId);
  return row;
}

export function sectionsOf(db: Database, documentId: string) {
  return db
    .select()
    .from(documentSections)
    .where(eq(documentSections.documentId, documentId))
    .orderBy(asc(documentSections.position));
}

/** "page 2", "3:00–5:00": where each cited section came from, for showing beside what was made from it. */
export async function sourceRefs(db: Database, sectionIds: Array<string | null>) {
  const ids = [...new Set(sectionIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: documentSections.id, sourceRef: documentSections.sourceRef })
    .from(documentSections)
    .where(inArray(documentSections.id, ids));
  return new Map(rows.map((r) => [r.id, r.sourceRef]));
}

/** Nothing is generated from text nobody has checked: a misread number would become a wrong answer. */
export async function groundedSections(db: Database, actor: Actor, documentId: string) {
  const { source } = await documentFor(db, actor, documentId);
  const sections = await sectionsOf(db, documentId);
  const pending = sections.filter((s) => s.needsReview).length;
  if (pending > 0) {
    throw new TutorError(
      "NEEDS_REVIEW",
      `${pending} part${pending === 1 ? "" : "s"} of this material could not be read clearly. Check ${pending === 1 ? "it" : "them"} first.`,
      { pending },
    );
  }
  return {
    source,
    sections: sections.map((s) => ({ id: s.id, heading: s.heading, text: s.correctedText ?? s.text })),
  };
}

/** The next activity, from which parts of the material were missed. */
export function nextStepFor(missedSectionIds: string[], allRight: boolean): NextStep {
  if (missedSectionIds.length > 0) {
    return {
      activity: "review_flashcards",
      reason: `Go over the ${missedSectionIds.length === 1 ? "part" : `${missedSectionIds.length} parts`} you missed with flashcards, then try the quiz again.`,
      sectionIds: missedSectionIds,
    };
  }
  return allRight
    ? { activity: "harder_quiz", reason: "Every answer was right. Try a harder quiz next.", sectionIds: [] }
    : { activity: "retry_quiz", reason: "Have another go at the quiz.", sectionIds: [] };
}

const MASTERY_WINDOW = 20;

/** Quizzes and interviews both answer questions about the material, so both count towards mastery. */
export const ANSWER_KINDS = ["quiz_answer", "interview_answer"];

/** Mastery is the share right of the member's last 20 answers on this material. */
export async function recordProgress(tx: Tx, actor: Actor, documentId: string, nextStep: NextStep): Promise<number> {
  const recent = await tx
    .select({ correct: learningEvidence.correct })
    .from(learningEvidence)
    .where(
      and(
        eq(learningEvidence.memberId, actor.memberId),
        eq(learningEvidence.documentId, documentId),
        inArray(learningEvidence.kind, ANSWER_KINDS),
      ),
    )
    .orderBy(desc(learningEvidence.createdAt))
    .limit(MASTERY_WINDOW);
  const mastery = recent.length === 0 ? 0 : Math.round((recent.filter((r) => r.correct).length / recent.length) * 100) / 100;
  await tx
    .insert(learningProgress)
    .values({ familyId: actor.familyId, memberId: actor.memberId, documentId, mastery, nextStep })
    .onConflictDoUpdate({
      target: [learningProgress.memberId, learningProgress.documentId],
      set: { mastery, nextStep, updatedAt: new Date() },
    });
  return mastery;
}
