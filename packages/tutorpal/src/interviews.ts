import { randomUUID } from "node:crypto";

import { type Database, type InterviewQuestion, interviewSessions, learningEvidence } from "@brainpal/database";
import { and, desc, eq } from "drizzle-orm";

import {
  type Actor,
  assertOwner,
  assertVisible,
  clamp,
  groundedSections,
  isParent,
  nextStepFor,
  normalise,
  notFound,
  recordProgress,
  sectionsOf,
} from "./access.js";
import { type InterviewPrompt, tutorAi } from "./ai.js";
import { TutorError } from "./errors.js";

/** A wrong answer gets a nudge and one more go; after that TutorPAL moves on. */
const MAX_TRIES = 2;
const UNSURE_MARK_BELOW = 0.7;

type Session = typeof interviewSessions.$inferSelect;

const newQuestion = (p: InterviewPrompt): InterviewQuestion => ({
  id: randomUUID(),
  prompt: p.prompt,
  answer: p.answer,
  sectionId: p.sectionId,
  replies: [],
  done: false,
  revealed: false,
});

const answeredRight = (q: InterviewQuestion) => q.replies.some((r) => r.correct);

/** Expected answers stay on the server until the child gets it right or asks for it. */
function publicInterview(s: Session) {
  const current = s.status === "active" ? s.questions.find((q) => !q.done) : undefined;
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    memberId: s.memberId,
    documentId: s.documentId,
    questionCount: s.questionCount,
    score: s.questions.filter(answeredRight).length,
    currentQuestionId: current?.id ?? null,
    questions: s.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      sectionId: q.sectionId,
      done: q.done,
      replies: q.replies.map((r) => ({
        text: r.text,
        correct: r.correct,
        feedback: r.feedback,
        needsReview: r.confidence < UNSURE_MARK_BELOW,
      })),
      ...(q.revealed || answeredRight(q) ? { answer: q.answer } : {}),
    })),
  };
}

async function sessionFor(db: Database, actor: Actor, id: string) {
  const [session] = await db
    .select()
    .from(interviewSessions)
    .where(and(eq(interviewSessions.id, id), eq(interviewSessions.familyId, actor.familyId)))
    .limit(1);
  if (!session) throw notFound();
  assertVisible(actor, session.memberId);
  return session;
}

/**
 * Writes the session only if nobody else has since: two answers sent at once
 * (a double tap, two tabs) must not both be marked against the same question.
 * Model calls happen before this, so no lock is held while waiting on them.
 */
async function saveIf(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], s: Session, set: Partial<Session>) {
  const [updated] = await tx
    .update(interviewSessions)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(interviewSessions.id, s.id), eq(interviewSessions.updatedAt, s.updatedAt)))
    .returning();
  if (!updated) throw new TutorError("CONFLICT", "That crossed with another answer. Reload and carry on.");
  return updated;
}

export async function startInterview(db: Database, actor: Actor, documentId: string, count = 5) {
  const { source, sections } = await groundedSections(db, actor, documentId);
  assertOwner(actor, source.ownerMemberId, "Interviews");

  const first = await tutorAi().interviewQuestion(sections, []);
  if (!first) throw new TutorError("NOTHING_GENERATED", "TutorPAL could not think of a question from this material.");

  const now = new Date();
  const [session] = await db
    .insert(interviewSessions)
    .values({
      familyId: actor.familyId,
      memberId: actor.memberId,
      documentId,
      title: `${source.title} — interview`,
      questionCount: clamp(count, 1, 10),
      questions: [newQuestion(first)],
      // Set here rather than by the database: saveIf compares it, and Postgres
      // keeps microseconds that a JavaScript Date would round away.
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return publicInterview(session!);
}

/** Marks the answer to the current question, then asks the next one or wraps up. */
export async function answerInterview(db: Database, actor: Actor, id: string, text: string) {
  const s = await sessionFor(db, actor, id);
  assertOwner(actor, s.memberId, "Interview answers");
  if (s.status === "complete") {
    throw new TutorError("INTERVIEW_OVER", "This interview is finished. Start a new one to keep practising.");
  }
  const index = s.questions.findIndex((q) => !q.done);
  const question = s.questions[index];
  if (!question) throw new TutorError("INTERVIEW_OVER", "This interview is finished.");

  const sections = s.documentId
    ? (await sectionsOf(db, s.documentId)).map((x) => ({ id: x.id, heading: x.heading, text: x.correctedText ?? x.text }))
    : [];
  const given = text.trim().slice(0, 1000);
  const mark =
    normalise(given) === normalise(question.answer)
      ? { correct: true, confidence: 1, feedback: "Exactly right." }
      : await tutorAi().markShortAnswer(
          { prompt: question.prompt, answer: question.answer },
          given,
          sections.find((x) => x.id === question.sectionId)?.text ?? "",
        );

  const replies = [...question.replies, { text: given, ...mark }];
  const settled = mark.correct || replies.length >= MAX_TRIES;
  const questions = s.questions.map((q, i) => (i === index ? { ...q, replies, done: settled } : q));

  if (settled && questions.length < s.questionCount && sections.length > 0) {
    const next = await tutorAi().interviewQuestion(sections, questions.map((q) => q.prompt));
    if (next) questions.push(newQuestion(next));
  }
  const complete = questions.every((q) => q.done);
  const nextStep = complete
    ? nextStepFor(
        [...new Set(questions.flatMap((q) => (!answeredRight(q) && q.sectionId ? [q.sectionId] : [])))],
        questions.every(answeredRight),
      )
    : null;

  const { session, mastery } = await db.transaction(async (tx) => {
    const session = await saveIf(tx, s, { questions, status: complete ? "complete" : "active" });
    if (settled) {
      await tx.insert(learningEvidence).values({
        familyId: actor.familyId,
        memberId: actor.memberId,
        documentId: s.documentId,
        sectionId: question.sectionId,
        kind: "interview_answer",
        refId: s.id,
        correct: mark.correct,
        confidence: mark.confidence,
        detail: { questionId: question.id, tries: replies.length },
      });
    }
    const mastery = nextStep && s.documentId ? await recordProgress(tx, actor, s.documentId, nextStep) : null;
    return { session, mastery };
  });

  return {
    ...publicInterview(session),
    reply: {
      questionId: question.id,
      correct: mark.correct,
      feedback: mark.feedback,
      needsReview: mark.confidence < UNSURE_MARK_BELOW,
      tryAgain: !settled,
    },
    ...(nextStep ? { nextStep, mastery } : {}),
  };
}

/** Only once the child has had their go at it: asking first would skip the practice. */
export async function revealInterviewAnswer(db: Database, actor: Actor, id: string, questionId: string) {
  const s = await sessionFor(db, actor, id);
  const question = s.questions.find((q) => q.id === questionId);
  if (!question) throw notFound();
  if (!question.done) throw new TutorError("NOT_YET", "Have a go at this one first.");

  await db.transaction((tx) =>
    saveIf(tx, s, { questions: s.questions.map((q) => (q.id === questionId ? { ...q, revealed: true } : q)) }),
  );
  return { questionId, answer: question.answer };
}

export async function getInterview(db: Database, actor: Actor, id: string) {
  return publicInterview(await sessionFor(db, actor, id));
}

export async function listInterviews(db: Database, actor: Actor) {
  const rows = await db
    .select()
    .from(interviewSessions)
    .where(
      and(
        eq(interviewSessions.familyId, actor.familyId),
        ...(isParent(actor) ? [] : [eq(interviewSessions.memberId, actor.memberId)]),
      ),
    )
    .orderBy(desc(interviewSessions.createdAt))
    .limit(50);
  return rows.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    memberId: s.memberId,
    documentId: s.documentId,
    score: s.questions.filter(answeredRight).length,
    asked: s.questions.length,
    createdAt: s.createdAt.toISOString(),
  }));
}
