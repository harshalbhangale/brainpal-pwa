import { randomUUID } from "node:crypto";

import {
  type Database,
  type NextStep,
  type QuizQuestion,
  type QuizResult,
  documentSections,
  familyMembers,
  flashcardDecks,
  flashcards,
  learningDocuments,
  learningEvidence,
  learningProgress,
  learningSources,
  quizAttempts,
  quizDefinitions,
  studentProfiles,
  subjects,
} from "@brainpal/database";
import { and, asc, desc, eq, ne } from "drizzle-orm";

import { type ExtractedSection, tutorAi } from "./ai.js";
import { TutorError } from "./errors.js";
import { extractPdf } from "./extraction.js";
import { type Grade, schedule } from "./srs.js";
import { blobStore } from "./storage.js";

export type Role = "parent" | "co_guardian" | "child";

export interface Actor {
  memberId: string;
  familyId: string;
  role: Role;
}

export const ACCEPTED_TYPES: Record<string, "pdf" | "image"> = {
  "application/pdf": "pdf",
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const REVIEW_BELOW = 0.85;
const UNSURE_MARK_BELOW = 0.7;
const MASTERY_WINDOW = 20;

const isParent = (actor: Actor) => actor.role === "parent" || actor.role === "co_guardian";
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const notFound = () => new TutorError("NOT_FOUND", "That was not found.");

/**
 * A parent sees every child's material; a child sees only their own. Refusal
 * reads exactly like absence, so one child cannot learn another's ids exist.
 */
function assertVisible(actor: Actor, ownerMemberId: string): void {
  if (!isParent(actor) && actor.memberId !== ownerMemberId) throw notFound();
}

/** Attempts and reviews are evidence of the child's own learning, so only they can make them. */
function assertOwner(actor: Actor, ownerMemberId: string, what: string): void {
  if (actor.memberId !== ownerMemberId) {
    throw new TutorError("CHILD_ONLY", `${what} count towards the child's own learning, so only they can do it.`);
  }
}

async function childOf(db: Database, familyId: string, memberId: string) {
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

async function sourceFor(db: Database, actor: Actor, sourceId: string) {
  const [source] = await db
    .select()
    .from(learningSources)
    .where(and(eq(learningSources.id, sourceId), eq(learningSources.familyId, actor.familyId)))
    .limit(1);
  if (!source) throw notFound();
  assertVisible(actor, source.ownerMemberId);
  return source;
}

async function documentFor(db: Database, actor: Actor, documentId: string) {
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

function sectionsOf(db: Database, documentId: string) {
  return db
    .select()
    .from(documentSections)
    .where(eq(documentSections.documentId, documentId))
    .orderBy(asc(documentSections.position));
}

// ---------- Material ----------

export async function uploadSource(
  db: Database,
  actor: Actor,
  input: { ownerMemberId?: string | undefined; title: string; mimeType: string; bytes: Uint8Array },
) {
  const kind = ACCEPTED_TYPES[input.mimeType];
  if (!kind) throw new TutorError("UNSUPPORTED_FILE", "Upload a PDF or a photo (JPEG, PNG or WebP).");
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new TutorError("FILE_TOO_LARGE", "Files can be up to 10 MB.");
  }

  const ownerMemberId = input.ownerMemberId ?? actor.memberId;
  assertVisible(actor, ownerMemberId);
  await childOf(db, actor.familyId, ownerMemberId);

  const id = randomUUID();
  const storageKey = `families/${actor.familyId}/sources/${id}`;
  await blobStore().put(storageKey, input.bytes, input.mimeType);
  await db.insert(learningSources).values({
    id,
    familyId: actor.familyId,
    ownerMemberId,
    uploadedByMemberId: actor.memberId,
    kind,
    title: input.title,
    storageKey,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  });

  return extractSource(db, actor, id);
}

/** Reads the stored file. A failure is recorded on the source, so it can be retried rather than lost. */
export async function extractSource(db: Database, actor: Actor, sourceId: string) {
  const source = await sourceFor(db, actor, sourceId);

  let method = "";
  let sections: ExtractedSection[] = [];
  try {
    const bytes = await blobStore().get(source.storageKey);
    if (source.kind === "pdf") {
      ({ method, sections } = await extractPdf(bytes));
    } else {
      method = "vision";
      sections = await tutorAi().read(bytes, source.mimeType, "photo");
    }
    if (sections.length === 0) throw new TutorError("NOTHING_FOUND", "No text could be found in that file.");
  } catch (error) {
    await db
      .update(learningSources)
      .set({ status: "failed", errorCode: error instanceof TutorError ? error.code : "EXTRACTION_FAILED" })
      .where(eq(learningSources.id, source.id));
    if (error instanceof TutorError) throw error;
    throw new TutorError("EXTRACTION_FAILED", "We could not read that file. Try a clearer photo or another PDF.");
  }

  const documentId = await db.transaction(async (tx) => {
    await tx.delete(learningDocuments).where(eq(learningDocuments.sourceId, source.id));
    const [doc] = await tx
      .insert(learningDocuments)
      .values({ familyId: actor.familyId, sourceId: source.id, method })
      .returning({ id: learningDocuments.id });
    await tx.insert(documentSections).values(
      sections.map((s, position) => ({
        documentId: doc!.id,
        familyId: actor.familyId,
        position,
        heading: s.heading,
        text: s.text,
        confidence: s.confidence,
        needsReview: s.confidence < REVIEW_BELOW || s.uncertainParts.length > 0,
        uncertainParts: s.uncertainParts,
        sourceRef: s.sourceRef,
      })),
    );
    await tx.update(learningSources).set({ status: "ready", errorCode: null }).where(eq(learningSources.id, source.id));
    return doc!.id;
  });

  return getDocument(db, actor, documentId);
}

export async function listSources(db: Database, actor: Actor) {
  return db
    .select({
      id: learningSources.id,
      title: learningSources.title,
      kind: learningSources.kind,
      status: learningSources.status,
      errorCode: learningSources.errorCode,
      ownerMemberId: learningSources.ownerMemberId,
      createdAt: learningSources.createdAt,
      documentId: learningDocuments.id,
    })
    .from(learningSources)
    .leftJoin(learningDocuments, eq(learningDocuments.sourceId, learningSources.id))
    .where(
      and(
        eq(learningSources.familyId, actor.familyId),
        ...(isParent(actor) ? [] : [eq(learningSources.ownerMemberId, actor.memberId)]),
      ),
    )
    .orderBy(desc(learningSources.createdAt));
}

export async function getDocument(db: Database, actor: Actor, documentId: string) {
  const { doc, source } = await documentFor(db, actor, documentId);
  const sections = await sectionsOf(db, doc.id);
  return {
    id: doc.id,
    sourceId: source.id,
    title: source.title,
    kind: source.kind,
    ownerMemberId: source.ownerMemberId,
    method: doc.method,
    needsReview: sections.filter((s) => s.needsReview).length,
    sections: sections.map((s) => ({
      id: s.id,
      position: s.position,
      heading: s.heading,
      text: s.correctedText ?? s.text,
      originalText: s.text,
      corrected: s.correctedText !== null,
      confidence: s.confidence,
      needsReview: s.needsReview,
      uncertainParts: s.uncertainParts ?? [],
      sourceRef: s.sourceRef,
    })),
  };
}

/** Confirming a section as-is and correcting it both clear its review flag; the original is kept. */
export async function correctSection(db: Database, actor: Actor, sectionId: string, text: string) {
  const [row] = await db
    .select({ section: documentSections, owner: learningSources.ownerMemberId })
    .from(documentSections)
    .innerJoin(learningDocuments, eq(learningDocuments.id, documentSections.documentId))
    .innerJoin(learningSources, eq(learningSources.id, learningDocuments.sourceId))
    .where(and(eq(documentSections.id, sectionId), eq(documentSections.familyId, actor.familyId)))
    .limit(1);
  if (!row) throw notFound();
  assertVisible(actor, row.owner);

  const trimmed = text.trim();
  await db
    .update(documentSections)
    .set({
      correctedText: trimmed === row.section.text ? null : trimmed,
      needsReview: false,
      updatedAt: new Date(),
    })
    .where(eq(documentSections.id, sectionId));
  return getDocument(db, actor, row.section.documentId);
}

/** Nothing is generated from text nobody has checked: a misread number would become a wrong answer. */
async function groundedSections(db: Database, actor: Actor, documentId: string) {
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

// ---------- Flashcards ----------

export async function createDeck(db: Database, actor: Actor, documentId: string, count = 10) {
  const { source, sections } = await groundedSections(db, actor, documentId);
  const generated = await tutorAi().makeFlashcards(sections, clamp(count, 1, 30));
  // Asked for more cards than the material has facts, a model pads with rewordings of the
  // same card. One card per fact: the same section with the same answer is a repeat.
  const seen = new Set<string>();
  const cards = generated.filter((c) => {
    const key = `${c.sectionId}|${normalise(c.back)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (cards.length === 0) throw new TutorError("NOTHING_GENERATED", "TutorPAL could not make flashcards from this material.");

  const deckId = await db.transaction(async (tx) => {
    const [deck] = await tx
      .insert(flashcardDecks)
      .values({
        familyId: actor.familyId,
        ownerMemberId: source.ownerMemberId,
        documentId,
        title: `${source.title} — flashcards`,
        createdByMemberId: actor.memberId,
      })
      .returning({ id: flashcardDecks.id });
    await tx.insert(flashcards).values(
      cards.map((c) => ({ deckId: deck!.id, familyId: actor.familyId, front: c.front, back: c.back, sectionId: c.sectionId })),
    );
    return deck!.id;
  });
  return getDeck(db, actor, deckId);
}

export async function listDecks(db: Database, actor: Actor) {
  return db
    .select({
      id: flashcardDecks.id,
      title: flashcardDecks.title,
      ownerMemberId: flashcardDecks.ownerMemberId,
      documentId: flashcardDecks.documentId,
      createdAt: flashcardDecks.createdAt,
    })
    .from(flashcardDecks)
    .where(
      and(
        eq(flashcardDecks.familyId, actor.familyId),
        ...(isParent(actor) ? [] : [eq(flashcardDecks.ownerMemberId, actor.memberId)]),
      ),
    )
    .orderBy(desc(flashcardDecks.createdAt));
}

export async function getDeck(db: Database, actor: Actor, deckId: string) {
  const [deck] = await db
    .select()
    .from(flashcardDecks)
    .where(and(eq(flashcardDecks.id, deckId), eq(flashcardDecks.familyId, actor.familyId)))
    .limit(1);
  if (!deck) throw notFound();
  assertVisible(actor, deck.ownerMemberId);

  const cards = await db.select().from(flashcards).where(eq(flashcards.deckId, deck.id)).orderBy(asc(flashcards.dueAt));
  const now = Date.now();
  return {
    id: deck.id,
    title: deck.title,
    ownerMemberId: deck.ownerMemberId,
    documentId: deck.documentId,
    dueCount: cards.filter((c) => c.dueAt.getTime() <= now).length,
    cards: cards.map((c) => ({
      id: c.id,
      front: c.front,
      back: c.back,
      sectionId: c.sectionId,
      state: c.state,
      intervalDays: c.intervalDays,
      dueAt: c.dueAt.toISOString(),
    })),
  };
}

export async function reviewCard(db: Database, actor: Actor, cardId: string, grade: Grade) {
  const [row] = await db
    .select({ card: flashcards, owner: flashcardDecks.ownerMemberId, documentId: flashcardDecks.documentId })
    .from(flashcards)
    .innerJoin(flashcardDecks, eq(flashcardDecks.id, flashcards.deckId))
    .where(and(eq(flashcards.id, cardId), eq(flashcards.familyId, actor.familyId)))
    .limit(1);
  if (!row) throw notFound();
  assertVisible(actor, row.owner);
  assertOwner(actor, row.owner, "Reviews");

  const next = schedule(row.card, grade, new Date());
  await db.transaction(async (tx) => {
    await tx.update(flashcards).set(next).where(eq(flashcards.id, cardId));
    await tx.insert(learningEvidence).values({
      familyId: actor.familyId,
      memberId: actor.memberId,
      documentId: row.documentId,
      sectionId: row.card.sectionId,
      kind: "flashcard_review",
      refId: cardId,
      correct: grade !== "again",
      confidence: 1,
      detail: { grade },
    });
  });
  return { id: cardId, state: next.state, intervalDays: next.intervalDays, dueAt: next.dueAt.toISOString() };
}

// ---------- Quizzes ----------

function publicQuiz(quiz: typeof quizDefinitions.$inferSelect) {
  return {
    id: quiz.id,
    title: quiz.title,
    difficulty: quiz.difficulty,
    ownerMemberId: quiz.ownerMemberId,
    documentId: quiz.documentId,
    // Answers, hints and explanations never leave the server with the questions.
    questions: quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      ...(q.options ? { options: q.options } : {}),
    })),
  };
}

export async function createQuiz(
  db: Database,
  actor: Actor,
  documentId: string,
  opts: { count?: number | undefined; difficulty?: "easy" | "medium" | "hard" | undefined } = {},
) {
  const { source, sections } = await groundedSections(db, actor, documentId);
  const count = clamp(opts.count ?? 5, 1, 15);
  const difficulty = opts.difficulty ?? "medium";
  const generated = await tutorAi().makeQuiz(sections, count, difficulty);

  const questions: QuizQuestion[] = generated.slice(0, count).map((q) => ({
    id: randomUUID(),
    type: q.type,
    prompt: q.prompt,
    ...(q.options ? { options: q.options } : {}),
    answer: q.answer,
    hint: q.hint,
    explanation: q.explanation,
    sectionId: q.sectionId,
  }));
  if (questions.length === 0) throw new TutorError("NOTHING_GENERATED", "TutorPAL could not make a quiz from this material.");

  const [quiz] = await db
    .insert(quizDefinitions)
    .values({
      familyId: actor.familyId,
      ownerMemberId: source.ownerMemberId,
      documentId,
      title: `${source.title} — quiz`,
      difficulty,
      questions,
      createdByMemberId: actor.memberId,
    })
    .returning();
  return publicQuiz(quiz!);
}

export async function getQuiz(db: Database, actor: Actor, quizId: string) {
  const [quiz] = await db
    .select()
    .from(quizDefinitions)
    .where(and(eq(quizDefinitions.id, quizId), eq(quizDefinitions.familyId, actor.familyId)))
    .limit(1);
  if (!quiz) throw notFound();
  assertVisible(actor, quiz.ownerMemberId);
  return publicQuiz(quiz);
}

export async function listQuizzes(db: Database, actor: Actor) {
  return db
    .select({
      id: quizDefinitions.id,
      title: quizDefinitions.title,
      difficulty: quizDefinitions.difficulty,
      ownerMemberId: quizDefinitions.ownerMemberId,
      documentId: quizDefinitions.documentId,
      createdAt: quizDefinitions.createdAt,
    })
    .from(quizDefinitions)
    .where(
      and(
        eq(quizDefinitions.familyId, actor.familyId),
        ...(isParent(actor) ? [] : [eq(quizDefinitions.ownerMemberId, actor.memberId)]),
      ),
    )
    .orderBy(desc(quizDefinitions.createdAt));
}

function publicResult(result: QuizResult, question: QuizQuestion | undefined) {
  return {
    questionId: result.questionId,
    correct: result.correct,
    feedback: result.feedback,
    needsReview: result.needsReview,
    ...((result.correct || result.revealed) && question ? { correctAnswer: question.answer } : {}),
  };
}

/**
 * Marks a whole attempt. Multiple choice is marked in code; a short answer
 * that does not match exactly goes to the model, and a mark it is unsure of
 * is flagged for a parent. A wrong answer gets a hint, not the answer.
 */
export async function submitAttempt(
  db: Database,
  actor: Actor,
  quizId: string,
  answers: Array<{ questionId: string; answer: string }>,
) {
  const [quiz] = await db
    .select()
    .from(quizDefinitions)
    .where(and(eq(quizDefinitions.id, quizId), eq(quizDefinitions.familyId, actor.familyId)))
    .limit(1);
  if (!quiz) throw notFound();
  assertVisible(actor, quiz.ownerMemberId);
  assertOwner(actor, quiz.ownerMemberId, "Quiz attempts");

  const given = new Map(answers.map((a) => [a.questionId, a.answer.slice(0, 500)]));
  const sourceText = new Map(
    quiz.documentId
      ? (await sectionsOf(db, quiz.documentId)).map((s) => [s.id, s.correctedText ?? s.text] as const)
      : [],
  );

  const results: QuizResult[] = [];
  for (const q of quiz.questions) {
    const answer = given.get(q.id) ?? "";
    let correct: boolean;
    let confidence = 1;
    let feedback: string;

    if (!answer.trim()) {
      correct = false;
      feedback = q.hint;
    } else if (q.type === "mcq" || normalise(answer) === normalise(q.answer)) {
      correct = normalise(answer) === normalise(q.answer);
      feedback = correct ? q.explanation : q.hint;
    } else {
      const mark = await tutorAi().markShortAnswer(
        { prompt: q.prompt, answer: q.answer },
        answer,
        (q.sectionId && sourceText.get(q.sectionId)) || "",
      );
      correct = mark.correct;
      confidence = mark.confidence;
      feedback = mark.feedback;
    }
    results.push({ questionId: q.id, answer, correct, confidence, needsReview: confidence < UNSURE_MARK_BELOW, feedback, revealed: correct });
  }

  const score = results.filter((r) => r.correct).length;
  const missedSections = [
    ...new Set(
      quiz.questions.flatMap((q, i) => (!results[i]!.correct && q.sectionId ? [q.sectionId] : [])),
    ),
  ];
  const nextStep: NextStep =
    missedSections.length > 0
      ? {
          activity: "review_flashcards",
          reason: `Go over the ${missedSections.length === 1 ? "part" : `${missedSections.length} parts`} you missed with flashcards, then try the quiz again.`,
          sectionIds: missedSections,
        }
      : score === results.length
        ? { activity: "harder_quiz", reason: "Every answer was right. Try a harder quiz next.", sectionIds: [] }
        : { activity: "retry_quiz", reason: "Have another go at the quiz.", sectionIds: [] };

  const { attemptId, mastery } = await db.transaction(async (tx) => {
    const [attempt] = await tx
      .insert(quizAttempts)
      .values({ familyId: actor.familyId, quizId: quiz.id, memberId: actor.memberId, results, score, total: results.length })
      .returning({ id: quizAttempts.id });

    await tx.insert(learningEvidence).values(
      quiz.questions.map((q, i) => ({
        familyId: actor.familyId,
        memberId: actor.memberId,
        documentId: quiz.documentId,
        sectionId: q.sectionId,
        kind: "quiz_answer",
        refId: attempt!.id,
        correct: results[i]!.correct,
        confidence: results[i]!.confidence,
        detail: { questionId: q.id, needsReview: results[i]!.needsReview },
      })),
    );

    let mastery: number | null = null;
    if (quiz.documentId) {
      const recent = await tx
        .select({ correct: learningEvidence.correct })
        .from(learningEvidence)
        .where(
          and(
            eq(learningEvidence.memberId, actor.memberId),
            eq(learningEvidence.documentId, quiz.documentId),
            eq(learningEvidence.kind, "quiz_answer"),
          ),
        )
        .orderBy(desc(learningEvidence.createdAt))
        .limit(MASTERY_WINDOW);
      mastery = Math.round((recent.filter((r) => r.correct).length / recent.length) * 100) / 100;
      await tx
        .insert(learningProgress)
        .values({ familyId: actor.familyId, memberId: actor.memberId, documentId: quiz.documentId, mastery, nextStep })
        .onConflictDoUpdate({
          target: [learningProgress.memberId, learningProgress.documentId],
          set: { mastery, nextStep, updatedAt: new Date() },
        });
    }
    return { attemptId: attempt!.id, mastery };
  });

  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  return {
    attemptId,
    score,
    total: results.length,
    mastery,
    nextStep,
    results: results.map((r) => publicResult(r, byId.get(r.questionId))),
  };
}

/** The answer is available on request. Asking is recorded, since it changes what a wrong answer means. */
export async function revealAnswer(db: Database, actor: Actor, attemptId: string, questionId: string) {
  const [row] = await db
    .select({ attempt: quizAttempts, quiz: quizDefinitions })
    .from(quizAttempts)
    .innerJoin(quizDefinitions, eq(quizDefinitions.id, quizAttempts.quizId))
    .where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.familyId, actor.familyId)))
    .limit(1);
  if (!row) throw notFound();
  assertVisible(actor, row.attempt.memberId);

  const question = row.quiz.questions.find((q) => q.id === questionId);
  if (!question) throw notFound();

  await db
    .update(quizAttempts)
    .set({ results: row.attempt.results.map((r) => (r.questionId === questionId ? { ...r, revealed: true } : r)) })
    .where(eq(quizAttempts.id, attemptId));
  return { questionId, answer: question.answer, explanation: question.explanation };
}

// ---------- Progress and profile ----------

export async function progressFor(db: Database, actor: Actor, memberId?: string) {
  const target = memberId ?? actor.memberId;
  assertVisible(actor, target);

  const progress = await db
    .select({
      documentId: learningProgress.documentId,
      title: learningSources.title,
      mastery: learningProgress.mastery,
      nextStep: learningProgress.nextStep,
      updatedAt: learningProgress.updatedAt,
    })
    .from(learningProgress)
    .innerJoin(learningDocuments, eq(learningDocuments.id, learningProgress.documentId))
    .innerJoin(learningSources, eq(learningSources.id, learningDocuments.sourceId))
    .where(and(eq(learningProgress.memberId, target), eq(learningProgress.familyId, actor.familyId)))
    .orderBy(desc(learningProgress.updatedAt));

  const evidence = await db
    .select({
      kind: learningEvidence.kind,
      correct: learningEvidence.correct,
      confidence: learningEvidence.confidence,
      documentId: learningEvidence.documentId,
      sectionId: learningEvidence.sectionId,
      createdAt: learningEvidence.createdAt,
    })
    .from(learningEvidence)
    .where(and(eq(learningEvidence.memberId, target), eq(learningEvidence.familyId, actor.familyId)))
    .orderBy(desc(learningEvidence.createdAt))
    .limit(30);

  return { memberId: target, progress, evidence };
}

export async function getProfile(db: Database, actor: Actor, memberId: string) {
  assertVisible(actor, memberId);
  await childOf(db, actor.familyId, memberId);
  const [profile] = await db.select().from(studentProfiles).where(eq(studentProfiles.memberId, memberId)).limit(1);
  const subjectRows = await db
    .select({ id: subjects.id, name: subjects.name, nextExamDate: subjects.nextExamDate })
    .from(subjects)
    .where(eq(subjects.memberId, memberId))
    .orderBy(asc(subjects.name));
  return {
    memberId,
    schoolYear: profile?.schoolYear ?? null,
    curriculum: profile?.curriculum ?? null,
    goals: profile?.goals ?? null,
    studyTimes: profile?.studyTimes ?? null,
    subjects: subjectRows,
  };
}

export async function saveProfile(
  db: Database,
  actor: Actor,
  memberId: string,
  input: { schoolYear?: string | undefined; curriculum?: string | undefined; goals?: string | undefined; studyTimes?: string | undefined },
) {
  assertVisible(actor, memberId);
  await childOf(db, actor.familyId, memberId);
  const values = {
    schoolYear: input.schoolYear ?? null,
    curriculum: input.curriculum ?? null,
    goals: input.goals ?? null,
    studyTimes: input.studyTimes ?? null,
  };
  await db
    .insert(studentProfiles)
    .values({ familyId: actor.familyId, memberId, ...values })
    .onConflictDoUpdate({ target: studentProfiles.memberId, set: { ...values, updatedAt: new Date() } });
  return getProfile(db, actor, memberId);
}

export async function addSubject(
  db: Database,
  actor: Actor,
  memberId: string,
  name: string,
  nextExamDate?: string | undefined,
) {
  assertVisible(actor, memberId);
  await childOf(db, actor.familyId, memberId);
  await db
    .insert(subjects)
    .values({ familyId: actor.familyId, memberId, name: name.trim(), nextExamDate: nextExamDate ?? null })
    .onConflictDoNothing();
  return getProfile(db, actor, memberId);
}
