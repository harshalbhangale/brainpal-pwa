import { getDb } from "@brainpal/database";
import {
  ACCEPTED_TYPES,
  AUDIO_TYPES,
  MAX_AUDIO_BYTES,
  MAX_TEXT_CHARS,
  MAX_UPLOAD_BYTES,
  TutorError,
  addClass,
  addSubject,
  addTextSource,
  addYoutubeSource,
  answerInterview,
  correctSection,
  createCheatsheet,
  createDeck,
  createQuiz,
  extractSource,
  getCheatsheet,
  getDeck,
  getDocument,
  getInterview,
  getProfile,
  getQuiz,
  listCheatsheets,
  listDecks,
  listInterviews,
  listQuizzes,
  listSources,
  progressFor,
  removeClass,
  removeSubject,
  revealAnswer,
  revealInterviewAnswer,
  reviewCard,
  saveProfile,
  startInterview,
  submitAttempt,
  transcribeSpeech,
  updateSubject,
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
  INVALID_LINK: 400,
  INVALID_TIMES: 400,
  VIDEO_UNAVAILABLE: 422,
  YOUTUBE_BLOCKED: 503,
  NO_TRANSCRIPT: 422,
  NOTHING_HEARD: 422,
  TRANSCRIPT_FAILED: 502,
  TRANSCRIPTION_FAILED: 502,
  INTERVIEW_OVER: 409,
  NOT_YET: 409,
  CONFLICT: 409,
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

const mimeOf = (request: FastifyRequest) =>
  String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();

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

const Filing = { memberId: z.uuid().optional(), subjectId: z.uuid().optional() };
const UploadQuery = z.object({ title: z.string().min(1).max(200), ...Filing });
const TextSource = z.object({ title: z.string().min(1).max(200), text: z.string().min(1).max(MAX_TEXT_CHARS), ...Filing });
const YoutubeSource = z.object({ url: z.string().min(1).max(500), title: z.string().max(200).optional(), ...Filing });
const InterviewRequest = z.object({ count: z.number().int().min(1).max(10).optional() });
const InterviewAnswer = z.object({ text: z.string().trim().min(1).max(1000) });
const RevealQuestion = z.object({ questionId: z.uuid() });
const SubjectUpdate = z.object({ nextExamDate: z.iso.date().nullable() });
const ClassRequest = z.object({
  weekday: z.number().int().min(0).max(6),
  startsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  location: z.string().max(80).optional(),
});
const Correction = z.object({ text: z.string().min(1).max(20_000) });
const DeckRequest = z.object({ count: z.number().int().min(1).max(30).optional() });
const QuizRequest = z.object({
  count: z.number().int().min(1).max(15).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
});
const Review = z.object({
  grade: z.enum(["again", "hard", "good", "easy"]),
  // Sent by a review made offline and synced later.
  reviewedAt: z.iso.datetime({ offset: true }).optional(),
  clientRef: z.uuid().optional(),
});
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

  // Voice answers: the recording is the body. Matched by prefix, since
  // browsers add codec parameters ("audio/webm;codecs=opus").
  app.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: MAX_AUDIO_BYTES }, (_request, body, done) =>
    done(null, body),
  );

  app.post("/v1/learning/sources", { bodyLimit: MAX_UPLOAD_BYTES }, async (request) => {
    const query = parse(UploadQuery, request.query, "upload");
    const mimeType = mimeOf(request);
    if (!Buffer.isBuffer(request.body)) {
      throw new ApiError(415, "UNSUPPORTED_FILE", "Upload a PDF or a photo (JPEG, PNG or WebP).");
    }
    const bytes = new Uint8Array(request.body);
    return tutor(() =>
      uploadSource(getDb(), actorOf(request), {
        title: query.title,
        mimeType,
        bytes,
        ownerMemberId: query.memberId,
        subjectId: query.subjectId,
      }),
    );
  });

  app.post("/v1/learning/sources/text", { bodyLimit: MAX_TEXT_CHARS * 4 + 4096 }, async (request) => {
    const body = parse(TextSource, request.body, "notes");
    return tutor(() =>
      addTextSource(getDb(), actorOf(request), {
        title: body.title,
        text: body.text,
        ownerMemberId: body.memberId,
        subjectId: body.subjectId,
      }),
    );
  });

  app.post("/v1/learning/sources/youtube", async (request) => {
    const body = parse(YoutubeSource, request.body, "video link");
    return tutor(() =>
      addYoutubeSource(getDb(), actorOf(request), {
        url: body.url,
        title: body.title,
        ownerMemberId: body.memberId,
        subjectId: body.subjectId,
      }),
    );
  });

  app.post("/v1/learning/transcribe", { bodyLimit: MAX_AUDIO_BYTES }, async (request) => {
    const mimeType = mimeOf(request);
    if (!Buffer.isBuffer(request.body) || !AUDIO_TYPES.includes(mimeType)) {
      throw new ApiError(415, "UNSUPPORTED_FILE", "That recording format is not supported.");
    }
    return tutor(() => transcribeSpeech(new Uint8Array(request.body as Buffer), mimeType));
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
    const { grade, reviewedAt, clientRef } = parse(Review, request.body, "review");
    return tutor(() =>
      reviewCard(getDb(), actorOf(request), id, grade, {
        reviewedAt: reviewedAt ? new Date(reviewedAt) : undefined,
        clientRef,
      }),
    );
  });

  app.post("/v1/learning/documents/:id/cheatsheets", async (request) => {
    const { id } = parse(Id, request.params, "document");
    return tutor(() => createCheatsheet(getDb(), actorOf(request), id));
  });

  app.get("/v1/learning/cheatsheets", async (request) => ({
    cheatsheets: await tutor(() => listCheatsheets(getDb(), actorOf(request))),
  }));

  app.get("/v1/learning/cheatsheets/:id", async (request) => {
    const { id } = parse(Id, request.params, "cheatsheet");
    return tutor(() => getCheatsheet(getDb(), actorOf(request), id));
  });

  app.post("/v1/learning/documents/:id/interviews", async (request) => {
    const { id } = parse(Id, request.params, "document");
    const { count } = parse(InterviewRequest, request.body ?? {}, "interview request");
    return tutor(() => startInterview(getDb(), actorOf(request), id, count));
  });

  app.get("/v1/learning/interviews", async (request) => ({
    interviews: await tutor(() => listInterviews(getDb(), actorOf(request))),
  }));

  app.get("/v1/learning/interviews/:id", async (request) => {
    const { id } = parse(Id, request.params, "interview");
    return tutor(() => getInterview(getDb(), actorOf(request), id));
  });

  app.post("/v1/learning/interviews/:id/answers", async (request) => {
    const { id } = parse(Id, request.params, "interview");
    const { text } = parse(InterviewAnswer, request.body, "answer");
    return tutor(() => answerInterview(getDb(), actorOf(request), id, text));
  });

  app.post("/v1/learning/interviews/:id/reveal", async (request) => {
    const { id } = parse(Id, request.params, "interview");
    const { questionId } = parse(RevealQuestion, request.body, "reveal");
    return tutor(() => revealInterviewAnswer(getDb(), actorOf(request), id, questionId));
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

  app.post("/v1/learning/subjects/:id", async (request) => {
    const { id } = parse(Id, request.params, "subject");
    const body = parse(SubjectUpdate, request.body, "subject");
    return tutor(() => updateSubject(getDb(), actorOf(request), id, body));
  });

  app.delete("/v1/learning/subjects/:id", async (request) => {
    const { id } = parse(Id, request.params, "subject");
    return tutor(() => removeSubject(getDb(), actorOf(request), id));
  });

  app.post("/v1/learning/subjects/:id/classes", async (request) => {
    const { id } = parse(Id, request.params, "subject");
    const body = parse(ClassRequest, request.body, "class");
    return tutor(() => addClass(getDb(), actorOf(request), id, body));
  });

  app.delete("/v1/learning/classes/:id", async (request) => {
    const { id } = parse(Id, request.params, "class");
    return tutor(() => removeClass(getDb(), actorOf(request), id));
  });
}
