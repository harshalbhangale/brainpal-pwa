import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { mockToken } from "@brainpal/auth";
import {
  agentRuns,
  closePool,
  families,
  familyMembers,
  getDb,
  seedPalRegistry,
  users,
} from "@brainpal/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../dist/app.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
process.env["MOCK_AUTH"] = "true";

describe("agent turn", { skip: !hasDatabase }, () => {
  const db = getDb();
  let app: FastifyInstance;
  let familyId = "";
  let parentToken = "";

  before(async () => {
    await seedPalRegistry();
    app = await buildApp();
    await app.ready();

    const [family] = await db
      .insert(families)
      .values({ name: "TurnTest", currency: "AUD" })
      .returning();
    familyId = family!.id;

    const subject = `test-${crypto.randomUUID()}`;
    const [user] = await db.insert(users).values({ authSubject: subject }).returning();
    await db.insert(familyMembers).values({
      familyId,
      userId: user!.id,
      role: "parent",
      displayName: "Parent",
      status: "active",
    });
    parentToken = mockToken(subject);
  });

  after(async () => {
    await app.close();
    await db.delete(families).where(eq(families.id, familyId));
    await closePool();
  });

  const turn = (body: unknown, token?: string) =>
    app.inject({
      method: "POST",
      url: "/v1/agent/turn",
      payload: body,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  test("an anonymous turn is refused", async () => {
    assert.equal((await turn({ text: "hello" })).statusCode, 401);
  });

  test("an empty turn is rejected before any model is called", async () => {
    const res = await turn({ text: "" }, parentToken);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "INVALID_REQUEST");
  });

  test("a turn naming another family's thread is not found", async () => {
    const res = await turn(
      { text: "hello", threadId: crypto.randomUUID() },
      parentToken,
    );
    assert.equal(res.statusCode, 404);
  });

  test("the app degrades honestly when no model is configured", async () => {
    // Rule 9: the PWA must keep working when AI is unavailable, so this is a
    // stated 503 rather than a 500 or a hang.
    const key = process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    try {
      const res = await turn({ text: "how do I save?" }, parentToken);
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error.code, "AI_UNAVAILABLE");
    } finally {
      if (key) process.env["OPENAI_API_KEY"] = key;
    }
  });

  test("a rejected turn records no agent run", async () => {
    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.familyId, familyId));
    assert.equal(runs.length, 0, "runs are only created once a turn starts");
  });
});
