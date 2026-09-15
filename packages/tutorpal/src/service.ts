import { randomUUID } from "node:crypto";

import {
  type Database,
  type NextStep,
  type QuizQuestion,
  type QuizResult,
  classSessions,
  documentSections,
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
import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  type Actor,
  assertOwner,
  assertVisible,
  childOf,
  clamp,
  documentFor,
  groundedSections,
  isParent,
  nextStepFor,
  normalise,
  notFound,
  recordProgress,
  sectionsOf,
  sourceFor,
  subjectFor,
} from "./access.js";
import { type ExtractedSection, tutorAi } from "./ai.js";
import { TutorError } from "./errors.js";
import { extractPdf } from "./extraction.js";
import { type Grade, schedule } from "./srs.js";
import { blobStore } from "./storage.js";
import { type Transcript, textSections, transcriptSections, transcriptSource, youtubeVideoId } from "./transcript.js";

export type { Actor, Role } from "./access.js";

export const ACCEPTED_TYPES: Record<string, "pdf" | "image"> = {
  "application/pdf": "pdf",
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 100_000;
/** What browsers' MediaRecorder produces: WebM in Chrome and Firefox, MP4 in Safari. */
export const AUDIO_TYPES = ["audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-m4a", "audio/aac"];
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const REVIEW_BELOW = 0.85;
const UNSURE_MARK_BELOW = 0.7;
/** How far back an offline review may be dated. Anything older is dated when it arrives. */
const OFFLINE_WINDOW_MS = 30 * 86_400_000;

// ---------- Material ----------

interface Owner {
  ownerMemberId?: string | undefined;
  subjectId?: string | undefined;
}

async function storeSource(
  db: Database,
  actor: Actor,
  input: Owner & {
    kind: "pdf" | "image" | "youtube" | "text";
    title: string;
    mimeType: string;
    bytes: Uint8Array;
    sourceUrl?: string | undefined;
  },
) {
  const ownerMemberId = input.ownerMemberId ?? actor.memberId;
  assertVisible(actor, ownerMemberId);
  await childOf(db, actor.familyId, ownerMemberId);
  if (input.subjectId) await subjectFor(db, actor, input.subjectId, ownerMemberId);

  const id = randomUUID();
  const storageKey = `families/${actor.familyId}/sources/${id}`;
  await blobStore().put(storageKey, input.bytes, input.mimeType);
  await db.insert(learningSources).values({
    id,
    familyId: actor.familyId,
    ownerMemberId,
    uploadedByMemberId: actor.memberId,
    subjectId: input.subjectId ?? null,
    kind: input.kind,
    title: input.title.slice(0, 200),
    storageKey,
    sourceUrl: input.sourceUrl ?? null,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  });

  return extractSource(db, actor, id);
}

export async function uploadSource(
  db: Database,
  actor: Actor,
  input: Owner & { title: string; mimeType: string; bytes: Uint8Array },
) {
  const kind = ACCEPTED_TYPES[input.mimeType];
  if (!kind) throw new TutorError("UNSUPPORTED_FILE", "Upload a PDF or a photo (JPEG, PNG or WebP).");
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new TutorError("FILE_TOO_LARGE", "Files can be up to 10 MB.");
  }
  return storeSource(db, actor, { ...input, kind });
}

/** Pasted notes or a transcript. Stored like a file, so it is re-read and deleted the same way. */
export async function addTextSource(db: Database, actor: Actor, input: Owner & { title: string; text: string }) {
  const text = input.text.trim();
  if (!text) throw new TutorError("NOTHING_FOUND", "There is no text to use.");
  if (text.length > MAX_TEXT_CHARS) throw new TutorError("FILE_TOO_LARGE", "Notes can be up to 100,000 characters.");
  return storeSource(db, actor, {
    ...input,
    kind: "text",
    mimeType: "text/plain",
    bytes: new TextEncoder().encode(text),
  });
}

/**
 * A YouTube video, by its captions. The transcript is stored, so the video
 * being edited or taken down later does not change material already made from it.
 */
export async function addYoutubeSource(db: Database, actor: Actor, input: Owner & { url: string; title?: string | undefined }) {
  const videoId = youtubeVideoId(input.url);
  if (!videoId) throw new TutorError("INVALID_LINK", "That does not look like a YouTube video link.");
  // Settle who it is for before reaching out to YouTube.
  const ownerMemberId = input.ownerMemberId ?? actor.memberId;
  assertVisible(actor, ownerMemberId);
  await childOf(db, actor.familyId, ownerMemberId);

  const transcript = await transcriptSource().fetch(videoId);
  return storeSource(db, actor, {
    ownerMemberId,
    subjectId: input.subjectId,
    kind: "youtube",
    title: input.title?.trim() || transcript.title,
    mimeType: "application/json",
    bytes: new TextEncoder().encode(JSON.stringify(transcript)),
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
  });
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
    } else if (source.kind === "text") {
      method = "text";
      sections = textSections(new TextDecoder().decode(bytes));
    } else if (source.kind === "youtube") {
      const transcript = JSON.parse(new TextDecoder().decode(bytes)) as Transcript;
      method = transcript.auto ? "youtube_auto_captions" : "youtube_captions";
      sections = transcriptSections(transcript);
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
      subjectId: learningSources.subjectId,
      sourceUrl: learningSources.sourceUrl,
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
    sourceUrl: source.sourceUrl,
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
      cardCount: sql<number>`count(${flashcards.id})::int`,
      dueCount: sql<number>`(count(${flashcards.id}) filter (where ${flashcards.dueAt} <= now()))::int`,
    })
    .from(flashcardDecks)
    .leftJoin(flashcards, eq(flashcards.deckId, flashcardDecks.id))
    .where(
      and(
        eq(flashcardDecks.familyId, actor.familyId),
        ...(isParent(actor) ? [] : [eq(flashcardDecks.ownerMemberId, actor.memberId)]),
      ),
    )
    .groupBy(flashcardDecks.id)
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

/**
 * A review made offline arrives later with the time it was made and a
 * client-chosen reference. The time schedules the card as if it had arrived
 * then; the reference makes a retried sync a replay, not a second review.
 */
export async function reviewCard(
  db: Database,
  actor: Actor,
  cardId: string,
  grade: Grade,
  opts: { reviewedAt?: Date | undefined; clientRef?: string | undefined } = {},
) {
  const [row] = await db
    .select({ card: flashcards, owner: flashcardDecks.ownerMemberId, documentId: flashcardDecks.documentId })
    .from(flashcards)
    .innerJoin(flashcardDecks, eq(flashcardDecks.id, flashcards.deckId))
    .where(and(eq(flashcards.id, cardId), eq(flashcards.familyId, actor.familyId)))
    .limit(1);
  if (!row) throw notFound();
  assertVisible(actor, row.owner);
  assertOwner(actor, row.owner, "Reviews");

  const now = new Date();
  const age = opts.reviewedAt ? now.getTime() - opts.reviewedAt.getTime() : -1;
  const at = opts.reviewedAt && age >= 0 && age <= OFFLINE_WINDOW_MS ? opts.reviewedAt : now;

  const next = schedule(row.card, grade, at);
  const applied = await db.transaction(async (tx) => {
    const recorded = await tx
      .insert(learningEvidence)
      .values({
        familyId: actor.familyId,
        memberId: actor.memberId,
        documentId: row.documentId,
        sectionId: row.card.sectionId,
        kind: "flashcard_review",
        refId: cardId,
        correct: grade !== "again",
        confidence: 1,
        detail: { grade, ...(at === now ? {} : { offline: true }) },
        clientRef: opts.clientRef ?? null,
        createdAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: learningEvidence.id });
    if (recorded.length === 0) return false;
    await tx.update(flashcards).set(next).where(eq(flashcards.id, cardId));
    return true;
  });

  const card = applied ? next : row.card;
  return {
    id: cardId,
    state: card.state,
    intervalDays: card.intervalDays,
    dueAt: card.dueAt.toISOString(),
    replayed: !applied,
  };
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
  // Questions that fail validation are dropped, so ask for a couple spare and keep the first `count`.
  const generated = await tutorAi().makeQuiz(sections, count + 2, difficulty);

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
  const nextStep = nextStepFor(missedSections, score === results.length);

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

    const mastery = quiz.documentId ? await recordProgress(tx, actor, quiz.documentId, nextStep) : null;
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
  const classes = await db
    .select({
      id: classSessions.id,
      subjectId: classSessions.subjectId,
      weekday: classSessions.weekday,
      startsAt: classSessions.startsAt,
      endsAt: classSessions.endsAt,
      location: classSessions.location,
    })
    .from(classSessions)
    .where(eq(classSessions.memberId, memberId))
    .orderBy(asc(classSessions.weekday), asc(classSessions.startsAt));
  return {
    memberId,
    schoolYear: profile?.schoolYear ?? null,
    curriculum: profile?.curriculum ?? null,
    goals: profile?.goals ?? null,
    studyTimes: profile?.studyTimes ?? null,
    subjects: subjectRows.map((s) => ({ ...s, classes: classes.filter((c) => c.subjectId === s.id) })),
  };
}

// ---------- Voice ----------

/** Speech in, text out. The recording is not kept: only the words the child then sends are. */
export async function transcribeSpeech(bytes: Uint8Array, mimeType: string) {
  if (!AUDIO_TYPES.includes(mimeType)) throw new TutorError("UNSUPPORTED_FILE", "That recording format is not supported.");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new TutorError("FILE_TOO_LARGE", "Recordings can be up to 5 MB, about five minutes.");
  }
  let text: string;
  try {
    text = await tutorAi().transcribe(bytes);
  } catch {
    throw new TutorError("TRANSCRIPTION_FAILED", "We could not understand that recording. Try again, or type your answer.");
  }
  if (!text) throw new TutorError("NOTHING_HEARD", "We did not catch that. Try again a little closer to the microphone.");
  return { text };
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
