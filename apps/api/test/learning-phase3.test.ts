import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { mockToken } from "@brainpal/auth";
import { closePool, families, getDb, learningEvidence, seedPalRegistry } from "@brainpal/database";
import {
  LocalBlobStore,
  TutorError,
  type TutorAi,
  setBlobStore,
  setTranscriptSource,
  setTutorAi,
} from "@brainpal/tutorpal";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../dist/app.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
process.env["MOCK_AUTH"] = "true";

const VIDEO = "8aGhZQkoFbQ";
const NO_CAPTIONS = "AAAAAAAAAAA";

/** Three two-minute stretches of a lesson video, one fact in each. */
const LESSON = [
  { startMs: 0, durationMs: 5_000, text: "seven eights are fifty six" },
  { startMs: 130_000, durationMs: 5_000, text: "the capital of Australia is Canberra" },
  { startMs: 260_000, durationMs: 5_000, text: "water boils at one hundred degrees" },
];

/** Predictable TutorPAL: interview questions walk the sections in order, and only the exact words are right. */
const fakeAi: TutorAi = {
  read: async () => [],
  makeFlashcards: async (sections) => sections.map((s) => ({ front: `What was said at ${s.id.slice(0, 4)}?`, back: s.text, sectionId: s.id })),
  makeQuiz: async () => [],
  markShortAnswer: async (question, given) =>
    given.trim() === question.answer
      ? { correct: true, confidence: 1, feedback: "Nice." }
      : { correct: false, confidence: 0.9, feedback: "Think about what the video said." },
  makeCheatsheet: async (sections) => [
    { heading: "Facts", points: sections.map((s) => ({ text: s.text, sectionId: s.id })) },
  ],
  interviewQuestion: async (sections, asked) => {
    const next = sections[asked.length];
    return next ? { prompt: `Question ${asked.length + 1}: what did part ${asked.length + 1} say?`, answer: next.text, sectionId: next.id } : null;
  },
  transcribe: async () => "fifty six",
};

describe("TutorPAL: video, notes, cheatsheets, interviews, offline review and timetables", { skip: !hasDatabase }, () => {
  const db = getDb();
  let app: FastifyInstance;
  let uploads = "";
  let familyId = "";
  const parent = mockToken(`test-${crypto.randomUUID()}`);
  const maya = mockToken(`test-${crypto.randomUUID()}`);
  const leo = mockToken(`test-${crypto.randomUUID()}`);
  let mayaId = "";
  let leoId = "";
  let videoDoc = "";
  let interviewId = "";

  const call = (method: "GET" | "POST" | "DELETE", url: string, token: string, body?: unknown) =>
    app.inject({
      method,
      url,
      ...(body === undefined ? {} : { payload: body as object }),
      headers: { authorization: `Bearer ${token}` },
    });

  before(async () => {
    uploads = await mkdtemp(join(tmpdir(), "brainpal-uploads-"));
    setBlobStore(new LocalBlobStore(uploads));
    setTutorAi(fakeAi);
    setTranscriptSource({
      fetch: async (videoId) => {
        if (videoId === NO_CAPTIONS) throw new TutorError("NO_TRANSCRIPT", "That video has no captions.");
        return { videoId, title: "Lesson video", auto: true, segments: LESSON };
      },
    });
    await seedPalRegistry();
    app = await buildApp();
    await app.ready();

    familyId = (await call("POST", "/v1/onboarding/family", parent, { familyName: "Phase3", parentName: "Harshal", currency: "AUD" })).json().familyId;
    const m = (await call("POST", "/v1/families/current/children", parent, { displayName: "Maya" })).json();
    const l = (await call("POST", "/v1/families/current/children", parent, { displayName: "Leo" })).json();
    mayaId = m.member.id;
    leoId = l.member.id;
    await call("POST", "/v1/join", maya, { code: m.joinCode });
    await call("POST", "/v1/join", leo, { code: l.joinCode });
  });

  after(async () => {
    await app.close();
    await db.delete(families).where(eq(families.id, familyId));
    await closePool();
    await rm(uploads, { recursive: true, force: true });
  });

  test("a YouTube link becomes material in timed stretches, straight from its captions", async () => {
    const res = await call("POST", "/v1/learning/sources/youtube", maya, { url: `https://youtu.be/${VIDEO}?si=x` });
    assert.equal(res.statusCode, 200, res.body);
    const doc = res.json();
    videoDoc = doc.id;
    assert.equal(doc.title, "Lesson video");
    assert.equal(doc.kind, "youtube");
    assert.equal(doc.method, "youtube_auto_captions");
    assert.equal(doc.sourceUrl, `https://www.youtube.com/watch?v=${VIDEO}`);
    assert.deepEqual(doc.sections.map((s: { sourceRef: string }) => s.sourceRef), ["0:00–0:05", "2:10–2:15", "4:20–4:25"]);
    assert.equal(doc.needsReview, 0, "machine captions are not held for review");
  });

  test("a bad link and a video without captions are refused with a reason", async () => {
    const bad = await call("POST", "/v1/learning/sources/youtube", maya, { url: "https://vimeo.com/123" });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "INVALID_LINK");
    const none = await call("POST", "/v1/learning/sources/youtube", maya, { url: `https://www.youtube.com/watch?v=${NO_CAPTIONS}` });
    assert.equal(none.statusCode, 422);
    assert.equal(none.json().error.code, "NO_TRANSCRIPT");
  });

  test("pasted notes become material too", async () => {
    const res = await call("POST", "/v1/learning/sources/text", parent, {
      title: "Science notes",
      text: "Plants make food from sunlight.\n\nThis is called photosynthesis.",
      memberId: leoId,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().method, "text");
    assert.equal(res.json().ownerMemberId, leoId);
    assert.match(res.json().sections[0].text, /photosynthesis/);
  });

  test("a cheatsheet cites the part of the video each point came from", async () => {
    const res = await call("POST", `/v1/learning/documents/${videoDoc}/cheatsheets`, maya);
    assert.equal(res.statusCode, 200, res.body);
    const sheet = res.json();
    const points = sheet.blocks[0].points;
    assert.equal(points.length, 3);
    assert.equal(points[1].sourceRef, "2:10–2:15");
    assert.equal((await call("GET", `/v1/learning/cheatsheets/${sheet.id}`, parent)).statusCode, 200);
    assert.equal((await call("GET", `/v1/learning/cheatsheets/${sheet.id}`, leo)).statusCode, 404);
    assert.equal((await call("GET", "/v1/learning/cheatsheets", leo)).json().cheatsheets.length, 0);
  });

  test("interview: TutorPAL asks one question at a time, without sending the answer", async () => {
    const res = await call("POST", `/v1/learning/documents/${videoDoc}/interviews`, maya, { count: 3 });
    assert.equal(res.statusCode, 200, res.body);
    const interview = res.json();
    interviewId = interview.id;
    assert.equal(interview.questions.length, 1);
    assert.equal(interview.currentQuestionId, interview.questions[0].id);
    assert.ok(!JSON.stringify(interview).includes("fifty six"), "the expected answer stays on the server");

    const byParent = await call("POST", `/v1/learning/interviews/${interviewId}/answers`, parent, { text: "hi" });
    assert.equal(byParent.statusCode, 403);
    assert.equal((await call("GET", `/v1/learning/interviews/${interviewId}`, leo)).statusCode, 404);
  });

  test("interview: a right answer moves on; a wrong one gets a nudge and one more go", async () => {
    const right = (await call("POST", `/v1/learning/interviews/${interviewId}/answers`, maya, { text: "seven eights are fifty six" })).json();
    assert.equal(right.reply.correct, true);
    assert.equal(right.questions.length, 2);
    assert.equal(right.questions[0].answer, "seven eights are fifty six", "shown once she has it right");

    const wrong = (await call("POST", `/v1/learning/interviews/${interviewId}/answers`, maya, { text: "Sydney" })).json();
    assert.equal(wrong.reply.correct, false);
    assert.equal(wrong.reply.tryAgain, true);
    assert.equal(wrong.reply.feedback, "Think about what the video said.");
    assert.equal(wrong.currentQuestionId, wrong.questions[1].id, "the same question again");
    assert.equal(wrong.questions[1].answer, undefined);

    const early = await call("POST", `/v1/learning/interviews/${interviewId}/reveal`, maya, { questionId: wrong.questions[1].id });
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error.code, "NOT_YET");

    const again = (await call("POST", `/v1/learning/interviews/${interviewId}/answers`, maya, { text: "Melbourne" })).json();
    assert.equal(again.reply.tryAgain, false, "out of tries: moves on");
    assert.equal(again.questions.length, 3);

    const revealed = await call("POST", `/v1/learning/interviews/${interviewId}/reveal`, maya, { questionId: wrong.questions[1].id });
    assert.equal(revealed.json().answer, "the capital of Australia is Canberra");
  });

  test("interview: the last answer wraps up with a score, evidence and a next step", async () => {
    const done = (await call("POST", `/v1/learning/interviews/${interviewId}/answers`, maya, { text: "water boils at one hundred degrees" })).json();
    assert.equal(done.status, "complete");
    assert.equal(done.score, 2);
    assert.equal(done.mastery, 0.67);
    assert.equal(done.nextStep.activity, "review_flashcards");
    assert.equal(done.nextStep.sectionIds.length, 1);

    const evidence = await db
      .select()
      .from(learningEvidence)
      .where(and(eq(learningEvidence.refId, interviewId), eq(learningEvidence.kind, "interview_answer")));
    assert.equal(evidence.length, 3, "one row per question, not per try");

    const over = await call("POST", `/v1/learning/interviews/${interviewId}/answers`, maya, { text: "more" });
    assert.equal(over.statusCode, 409);
    assert.equal(over.json().error.code, "INTERVIEW_OVER");

    const list = (await call("GET", "/v1/learning/interviews", parent)).json().interviews;
    assert.equal(list[0].score, 2);
  });

  test("voice: a recording comes back as text, and odd formats are refused", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/learning/transcribe",
      payload: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]),
      headers: { authorization: `Bearer ${maya}`, "content-type": "audio/webm;codecs=opus" },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().text, "fifty six");

    const flac = await app.inject({
      method: "POST",
      url: "/v1/learning/transcribe",
      payload: Buffer.from([1, 2, 3]),
      headers: { authorization: `Bearer ${maya}`, "content-type": "audio/flac" },
    });
    assert.equal(flac.statusCode, 415);
  });

  test("offline review: synced later, dated when it happened, and counted once however often it is sent", async () => {
    const deck = (await call("POST", `/v1/learning/documents/${videoDoc}/flashcards`, maya, { count: 3 })).json();
    const decks = (await call("GET", "/v1/learning/decks", maya)).json().decks;
    assert.equal(decks[0].cardCount, 3);
    assert.equal(decks[0].dueCount, 3);

    const card = deck.cards[0].id;
    const clientRef = crypto.randomUUID();
    const reviewedAt = new Date(Date.now() - 86_400_000).toISOString();
    const first = (await call("POST", `/v1/learning/cards/${card}/review`, maya, { grade: "good", reviewedAt, clientRef })).json();
    assert.equal(first.replayed, false);
    // "Good" on a new card is one day, counted from when it was reviewed, not when it synced.
    assert.ok(Math.abs(new Date(first.dueAt).getTime() - Date.now()) < 60_000);

    const retry = (await call("POST", `/v1/learning/cards/${card}/review`, maya, { grade: "good", reviewedAt, clientRef })).json();
    assert.equal(retry.replayed, true);
    assert.equal(retry.dueAt, first.dueAt);
    const rows = await db.select().from(learningEvidence).where(eq(learningEvidence.clientRef, clientRef));
    assert.equal(rows.length, 1);

    const future = (await call("POST", `/v1/learning/cards/${deck.cards[1].id}/review`, maya, {
      grade: "good",
      reviewedAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    })).json();
    const inADay = Date.now() + 86_400_000;
    assert.ok(Math.abs(new Date(future.dueAt).getTime() - inADay) < 60_000, "a time in the future is ignored");
  });

  test("timetable: subjects hold weekly classes, and bad times are refused", async () => {
    const withSubject = (await call("POST", `/v1/learning/profiles/${mayaId}/subjects`, parent, { name: "Maths" })).json();
    const maths = withSubject.subjects[0].id;

    const added = await call("POST", `/v1/learning/subjects/${maths}/classes`, maya, { weekday: 1, startsAt: "09:00", endsAt: "09:50", location: "Room 4" });
    assert.equal(added.statusCode, 200, added.body);
    const lesson = added.json().subjects[0].classes[0];
    assert.equal(lesson.location, "Room 4");

    const backwards = await call("POST", `/v1/learning/subjects/${maths}/classes`, parent, { weekday: 1, startsAt: "10:00", endsAt: "09:00" });
    assert.equal(backwards.statusCode, 400);
    assert.equal(backwards.json().error.code, "INVALID_TIMES");
    assert.equal((await call("POST", `/v1/learning/subjects/${maths}/classes`, parent, { weekday: 9, startsAt: "10:00", endsAt: "11:00" })).statusCode, 400);

    assert.equal((await call("DELETE", `/v1/learning/classes/${lesson.id}`, leo)).statusCode, 404, "Leo cannot touch Maya's timetable");
    const exam = (await call("POST", `/v1/learning/subjects/${maths}`, parent, { nextExamDate: "2026-11-20" })).json();
    assert.equal(exam.subjects[0].nextExamDate, "2026-11-20");

    const filed = await call("POST", "/v1/learning/sources/text", maya, { title: "Fractions", text: "A half is one of two equal parts.", subjectId: maths });
    assert.equal(filed.statusCode, 200, filed.body);
    const leosSubject = (await call("POST", `/v1/learning/profiles/${leoId}/subjects`, parent, { name: "Art" })).json().subjects[0].id;
    const misfiled = await call("POST", "/v1/learning/sources/text", parent, { title: "x", text: "y", memberId: mayaId, subjectId: leosSubject });
    assert.equal(misfiled.statusCode, 404, "a subject must be the same child's");

    assert.equal((await call("DELETE", `/v1/learning/classes/${lesson.id}`, maya)).json().subjects[0].classes.length, 0);
    assert.equal((await call("DELETE", `/v1/learning/subjects/${maths}`, parent)).json().subjects.length, 0);
  });
});
