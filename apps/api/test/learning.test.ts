import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { mockToken } from "@brainpal/auth";
import { closePool, families, getDb, learningEvidence, seedPalRegistry } from "@brainpal/database";
import { LocalBlobStore, type TutorAi, setBlobStore, setTutorAi } from "@brainpal/tutorpal";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../dist/app.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
process.env["MOCK_AUTH"] = "true";

/** A predictable TutorPAL: the worksheet has one line it could not read. */
const fakeAi: TutorAi = {
  read: async (_bytes, _type, sourceRef) => [
    { heading: "Times tables", text: "7 x 8 = 56", confidence: 0.97, uncertainParts: [], sourceRef },
    { heading: null, text: "9 x 6 = 5?", confidence: 0.5, uncertainParts: ["5?"], sourceRef },
    { heading: "Area", text: "A 3 by 4 rectangle has area 12", confidence: 0.95, uncertainParts: [], sourceRef },
  ],
  makeFlashcards: async (sections) =>
    sections.map((s) => ({ front: `Recall: ${s.heading ?? "fact"}`, back: s.text, sectionId: s.id })),
  makeQuiz: async (sections) => {
    const [times, nines, area] = sections;
    const mcq = (prompt: string, answer: string, options: string[], sectionId: string) => ({
      type: "mcq" as const, prompt, options, answer, hint: `Think about ${prompt}`, explanation: `${prompt} is ${answer}`, sectionId,
    });
    const short = (prompt: string, answer: string, sectionId: string) => ({
      type: "short" as const, prompt, options: null, answer, hint: "Work it through", explanation: `It is ${answer}`, sectionId,
    });
    return [
      mcq("7 x 8", "56", ["54", "56", "58", "64"], times!.id),
      mcq("9 x 6", "54", ["45", "54", "56", "63"], nines!.id),
      mcq("area of 3 by 4", "12", ["7", "12", "14", "34"], area!.id),
      short("What is 7 x 8?", "56", times!.id),
      short("What is the area of a 3 by 4 rectangle?", "12", area!.id),
    ];
  },
  markShortAnswer: async (question, given) =>
    given.trim() === question.answer
      ? { correct: true, confidence: 1, feedback: "Nice work." }
      : { correct: false, confidence: 0.9, feedback: "Check your multiplication again." },
};

describe("TutorPAL: the worksheet loop", { skip: !hasDatabase }, () => {
  const db = getDb();
  let app: FastifyInstance;
  let uploads = "";
  let familyId = "";
  const parent = mockToken(`test-${crypto.randomUUID()}`);
  const maya = mockToken(`test-${crypto.randomUUID()}`);
  const leo = mockToken(`test-${crypto.randomUUID()}`);
  let mayaId = "";
  let documentId = "";
  let quiz: { id: string; questions: Array<{ id: string; type: string; options?: string[] }> };
  let attemptId = "";

  const call = (method: "GET" | "POST", url: string, token: string, body?: unknown) =>
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
    await seedPalRegistry();
    app = await buildApp();
    await app.ready();

    familyId = (await call("POST", "/v1/onboarding/family", parent, { familyName: "Learn", parentName: "Harshal", currency: "AUD" })).json().familyId;
    const m = (await call("POST", "/v1/families/current/children", parent, { displayName: "Maya" })).json();
    const l = (await call("POST", "/v1/families/current/children", parent, { displayName: "Leo" })).json();
    mayaId = m.member.id;
    await call("POST", "/v1/join", maya, { code: m.joinCode });
    await call("POST", "/v1/join", leo, { code: l.joinCode });
  });

  after(async () => {
    await app.close();
    await db.delete(families).where(eq(families.id, familyId));
    await closePool();
    await rm(uploads, { recursive: true, force: true });
  });

  test("1-2. a parent uploads a worksheet for Maya, and the unclear line is flagged", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/learning/sources?title=${encodeURIComponent("Maths worksheet")}&memberId=${mayaId}`,
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      headers: { authorization: `Bearer ${parent}`, "content-type": "image/png" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const doc = res.json();
    documentId = doc.id;
    assert.equal(doc.method, "vision");
    assert.equal(doc.needsReview, 1);
    const unclear = doc.sections.find((s: { needsReview: boolean }) => s.needsReview);
    assert.deepEqual(unclear.uncertainParts, ["5?"]);
  });

  test("an unsupported file type is refused, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/learning/sources?title=notes",
      payload: "just text",
      headers: { authorization: `Bearer ${maya}`, "content-type": "application/zip" },
    });
    assert.equal(res.statusCode, 415);
  });

  test("nothing is generated from material nobody has checked", async () => {
    const res = await call("POST", `/v1/learning/documents/${documentId}/flashcards`, maya, {});
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "NEEDS_REVIEW");
  });

  test("Maya corrects the unclear line, keeping the original beside it", async () => {
    const doc = (await call("GET", `/v1/learning/documents/${documentId}`, maya)).json();
    const unclear = doc.sections.find((s: { needsReview: boolean }) => s.needsReview);
    const res = await call("POST", `/v1/learning/sections/${unclear.id}`, maya, { text: "9 x 6 = 54" });
    assert.equal(res.statusCode, 200, res.body);
    const fixed = res.json().sections.find((s: { id: string }) => s.id === unclear.id);
    assert.equal(fixed.text, "9 x 6 = 54");
    assert.equal(fixed.originalText, "9 x 6 = 5?");
    assert.equal(res.json().needsReview, 0);
  });

  test("3a. Maya makes flashcards, each tied to the part of the worksheet it came from", async () => {
    const res = await call("POST", `/v1/learning/documents/${documentId}/flashcards`, maya, { count: 3 });
    assert.equal(res.statusCode, 200, res.body);
    const deck = res.json();
    assert.equal(deck.cards.length, 3);
    assert.ok(deck.cards.every((c: { sectionId: string | null }) => c.sectionId));
    assert.ok(deck.cards.some((c: { back: string }) => c.back === "9 x 6 = 54"), "cards use the corrected text");

    const reviewed = await call("POST", `/v1/learning/cards/${deck.cards[0].id}/review`, maya, { grade: "good" });
    assert.equal(reviewed.json().intervalDays, 1);
  });

  test("3b. Maya makes a five-question quiz, and no answers are sent to her", async () => {
    const res = await call("POST", `/v1/learning/documents/${documentId}/quizzes`, maya, { count: 5 });
    assert.equal(res.statusCode, 200, res.body);
    quiz = res.json();
    assert.equal(quiz.questions.length, 5);
    assert.ok(!JSON.stringify(quiz).includes('"answer"'), "no answer field");
    assert.ok(!JSON.stringify(quiz).includes('"hint"'), "no hint field");
  });

  test("4. TutorPAL marks the quiz and explains two mistakes without giving the answers away", async () => {
    const answers = ["56", "56", "12", "54", "12"].map((answer, i) => ({ questionId: quiz.questions[i]!.id, answer }));
    const res = await call("POST", `/v1/learning/quizzes/${quiz.id}/attempts`, maya, { answers });
    assert.equal(res.statusCode, 200, res.body);
    const attempt = res.json();
    attemptId = attempt.attemptId;
    assert.equal(attempt.score, 3);
    assert.equal(attempt.total, 5);

    const wrong = attempt.results.filter((r: { correct: boolean }) => !r.correct);
    assert.equal(wrong.length, 2);
    assert.equal(wrong[0].feedback, "Think about 9 x 6");
    assert.equal(wrong[1].feedback, "Check your multiplication again.");
    assert.ok(wrong.every((r: { correctAnswer?: string }) => r.correctAnswer === undefined));
    assert.ok(attempt.results.filter((r: { correct: boolean }) => r.correct).every((r: { correctAnswer?: string }) => r.correctAnswer));
  });

  test("5. the exact evidence and the next recommended activity are saved", async () => {
    const evidence = await db.select().from(learningEvidence).where(eq(learningEvidence.refId, attemptId));
    assert.equal(evidence.length, 5);
    assert.equal(evidence.filter((e) => e.correct).length, 3);

    const progress = (await call("GET", `/v1/learning/progress?memberId=${mayaId}`, parent)).json();
    const row = progress.progress.find((p: { documentId: string }) => p.documentId === documentId);
    assert.equal(row.mastery, 0.6);
    assert.equal(row.nextStep.activity, "review_flashcards");
    assert.equal(row.nextStep.sectionIds.length, 2);
  });

  test("the answer is shown when Maya asks for it", async () => {
    const res = await call("POST", `/v1/learning/attempts/${attemptId}/reveal`, maya, { questionId: quiz.questions[1]!.id });
    assert.equal(res.json().answer, "54");
  });

  test("a parent cannot take Maya's quiz for her", async () => {
    const res = await call("POST", `/v1/learning/quizzes/${quiz.id}/attempts`, parent, { answers: [] });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "CHILD_ONLY");
  });

  test("6. Leo cannot see Maya's worksheet, quiz or results — they look like they do not exist", async () => {
    assert.equal((await call("GET", `/v1/learning/documents/${documentId}`, leo)).statusCode, 404);
    assert.equal((await call("GET", `/v1/learning/quizzes/${quiz.id}`, leo)).statusCode, 404);
    assert.equal((await call("POST", `/v1/learning/quizzes/${quiz.id}/attempts`, leo, { answers: [] })).statusCode, 404);
    assert.equal((await call("POST", `/v1/learning/attempts/${attemptId}/reveal`, leo, { questionId: quiz.questions[0]!.id })).statusCode, 404);
    assert.equal((await call("GET", `/v1/learning/progress?memberId=${mayaId}`, leo)).statusCode, 404);
    assert.deepEqual((await call("GET", "/v1/learning/sources", leo)).json().sources, []);
  });

  test("a parent can set up a child's profile and subjects", async () => {
    await call("POST", `/v1/learning/profiles/${mayaId}`, parent, { schoolYear: "Year 5", curriculum: "NSW" });
    const res = await call("POST", `/v1/learning/profiles/${mayaId}/subjects`, parent, { name: "Maths", nextExamDate: "2026-11-20" });
    assert.equal(res.json().schoolYear, "Year 5");
    assert.equal(res.json().subjects[0].name, "Maths");
  });
});
