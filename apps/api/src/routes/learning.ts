import { getDb } from "@brainpal/database";
import {
  ACCEPTED_TYPES,
  MAX_UPLOAD_BYTES,
  TutorError,
  addSubject,
  correctSection,
  createDeck,
  createQuiz,
  extractSource,
  getDeck,
  getDocument,
  getProfile,
  getQuiz,
  listDecks,
  listQuizzes,
  listSources,
  progressFor,
  revealAnswer,
  reviewCard,
  saveProfile,
  submitAttempt,
  uploadSource,
} from "@brainpal/tutorpal";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { ApiError } from "../errors.js";

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  UNSUPPORTED_FILE: 415,
  FILE_TOO_LARGE: 413,
  NEEDS_REVIEW: 409,
  CHILD_ONLY: 403,
  NOTHING_FOUND: 422,
  NOTHING_GENERATED: 502,
  EXTRACTION_FAILED: 502,
};

async function tutor<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TutorError) {
      throw new ApiError(STATUS[error.code] ?? 409, error.code, error.message, error.details);
    }
    throw error;
  }
}

const actorOf = (request: FastifyRequest) => ({
  memberId: request.principal.memberId,
  familyId: request.principal.familyId,
  role: request.principal.role,
});

const Id = z.object({ id: z.uuid() });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "INVALID_REQUEST", `bad ${what}`, { issues: parsed.error.issues });
  return parsed.data;
}

const UploadQuery = z.object({ title: z.string().min(1).max(200), memberId: z.uuid().optional() });
const Correction = z.object({ text: z.string().min(1).max(20_000) });
const DeckRequest = z.object({ count: z.number().int().min(1).max(30).optional() });
const QuizRequest = z.object({
  count: z.number().int().min(1).max(15).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
});
const Review = z.object({ grade: z.enum(["again", "hard", "good", "easy"]) });
const Attempt = z.object({
  answers: z.array(z.object({ questionId: z.uuid(), answer: z.string().max(500) })).max(30),
});
const Reveal = z.object({ questionId: z.uuid() });
const Profile = z.object({
  schoolYear: z.string().max(40).optional(),
  curriculum: z.string().max(80).optional(),
  goals: z.string().max(500).optional(),
  studyTimes: z.string().max(200).optional(),
});
const Subject = z.object({ name: z.string().min(1).max(80), nextExamDate: z.iso.date().optional() });
const ProgressQuery = z.object({ memberId: z.uuid().optional() });

/** TutorPAL. Every route is family-scoped, and a child reaches only their own material. */
export async function registerLearningRoutes(app: FastifyInstance) {
  // Uploads arrive as the raw file with its own content type; everything else stays JSON.
  app.addContentTypeParser(
    Object.keys(ACCEPTED_TYPES),
    { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post("/v1/learning/sources", { bodyLimit: MAX_UPLOAD_BYTES }, async (request) => {
    const query = parse(UploadQuery, request.query, "upload");
    const mimeType = String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!Buffer.isBuffer(request.body)) {
      throw new ApiError(415, "UNSUPPORTED_FILE", "Upload a PDF or a photo (JPEG, PNG or WebP).");
    }
    const bytes = new Uint8Array(request.body);
    return tutor(() =>
      uploadSource(getDb(), actorOf(request), {
        title: query.title,
        mimeType,
        bytes,
        ...(query.memberId ? { ownerMemberId: query.memberId } : {}),
      }),
    );
  });

  app.get("/v1/learning/sources", async (request) => ({
    sources: await tutor(() => listSources(getDb(), actorOf(request))),
  }));

  app.post("/v1/learning/sources/:id/extract", async (request) => {
    const { id } = parse(Id, request.params, "source");
    return tutor(() => extractSource(getDb(), actorOf(request), id));
  });

  app.get("/v1/learning/documents/:id", async (request) => {
    const { id } = parse(Id, request.params, "document");
    return tutor(() => getDocument(getDb(), actorOf(request), id));
  });

  app.post("/v1/learning/sections/:id", async (request) => {
    const { id } = parse(Id, request.params, "section");
    const { text } = parse(Correction, request.body, "correction");
    return tutor(() => correctSection(getDb(), actorOf(request), id, text));
  });

  app.post("/v1/learning/documents/:id/flashcards", async (request) => {
    const { id } = parse(Id, request.params, "document");
    const { count } = parse(DeckRequest, request.body ?? {}, "deck request");
    return tutor(() => createDeck(getDb(), actorOf(request), id, count));
  });

  app.get("/v1/learning/decks", async (request) => ({
    decks: await tutor(() => listDecks(getDb(), actorOf(request))),
  }));

  app.get("/v1/learning/decks/:id", async (request) => {
    const { id } = parse(Id, request.params, "deck");
    return tutor(() => getDeck(getDb(), actorOf(request), id));
  });

  app.post("/v1/learning/cards/:id/review", async (request) => {
    const { id } = parse(Id, request.params, "card");
    const { grade } = parse(Review, request.body, "review");
    return tutor(() => reviewCard(getDb(), actorOf(request), id, grade));
  });

  app.post("/v1/learning/documents/:id/quizzes", async (request) => {
    const { id } = parse(Id, request.params, "document");
    const body = parse(QuizRequest, request.body ?? {}, "quiz request");
    return tutor(() => createQuiz(getDb(), actorOf(request), id, body));
  });

  app.get("/v1/learning/quizzes", async (request) => ({
    quizzes: await tutor(() => listQuizzes(getDb(), actorOf(request))),
  }));

  app.get("/v1/learning/quizzes/:id", async (request) => {
    const { id } = parse(Id, request.params, "quiz");
    return tutor(() => getQuiz(getDb(), actorOf(request), id));
  });

  app.post("/v1/learning/quizzes/:id/attempts", async (request) => {
    const { id } = parse(Id, request.params, "quiz");
    const { answers } = parse(Attempt, request.body, "attempt");
    return tutor(() => submitAttempt(getDb(), actorOf(request), id, answers));
  });

  app.post("/v1/learning/attempts/:id/reveal", async (request) => {
    const { id } = parse(Id, request.params, "attempt");
    const { questionId } = parse(Reveal, request.body, "reveal");
    return tutor(() => revealAnswer(getDb(), actorOf(request), id, questionId));
  });

  app.get("/v1/learning/progress", async (request) => {
    const { memberId } = parse(ProgressQuery, request.query, "progress query");
    return tutor(() => progressFor(getDb(), actorOf(request), memberId));
  });

  app.get("/v1/learning/profiles/:id", async (request) => {
    const { id } = parse(Id, request.params, "member");
    return tutor(() => getProfile(getDb(), actorOf(request), id));
  });

  app.post("/v1/learning/profiles/:id", async (request) => {
    const { id } = parse(Id, request.params, "member");
    const body = parse(Profile, request.body, "profile");
    return tutor(() => saveProfile(getDb(), actorOf(request), id, body));
  });

  app.post("/v1/learning/profiles/:id/subjects", async (request) => {
    const { id } = parse(Id, request.params, "member");
    const { name, nextExamDate } = parse(Subject, request.body, "subject");
    return tutor(() => addSubject(getDb(), actorOf(request), id, name, nextExamDate));
  });
}
