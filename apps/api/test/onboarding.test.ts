import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { mockToken } from "@brainpal/auth";
import { closePool, families, getDb, seedPalRegistry } from "@brainpal/database";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../dist/app.js";

const hasDatabase = Boolean(process.env["DATABASE_URL"]);
process.env["MOCK_AUTH"] = "true";

describe("onboarding", { skip: !hasDatabase }, () => {
  const db = getDb();
  let app: FastifyInstance;
  const createdFamilies: string[] = [];

  const newToken = () => mockToken(`test-${crypto.randomUUID()}`);

  const post = (url: string, body: unknown, token: string) =>
    app.inject({
      method: "POST",
      url,
      payload: body,
      headers: { authorization: `Bearer ${token}` },
    });

  const get = (url: string, token: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  async function newParent(name = "Bhangale", parentName = "Parent") {
    const token = newToken();
    const res = await post(
      "/v1/onboarding/family",
      { familyName: name, parentName, currency: "AUD" },
      token,
    );
    assert.equal(res.statusCode, 200);
    createdFamilies.push(res.json().familyId);
    return { token, ...res.json() };
  }

  before(async () => {
    await seedPalRegistry();
    app = await buildApp();
    await app.ready();
  });

  after(async () => {
    await app.close();
    for (const id of createdFamilies) {
      await db.delete(families).where(eq(families.id, id));
    }
    await closePool();
  });

  test("a signed-in user with no family can create one", async () => {
    const parent = await newParent();
    const me = (await get("/v1/me", parent.token)).json();
    assert.equal(me.role, "parent");
    assert.equal(me.familyId, parent.familyId);
  });

  test("the parent is named after themselves, not their family", async () => {
    const parent = await newParent("Bhangale", "Harshal");
    const me = (await get("/v1/me", parent.token)).json();
    assert.equal(me.displayName, "Harshal");
  });

  test("a family cannot be created without naming the parent", async () => {
    const res = await post(
      "/v1/onboarding/family",
      { familyName: "Nameless", currency: "AUD" },
      newToken(),
    );
    assert.equal(res.statusCode, 400);
  });

  test("a user cannot create a second family", async () => {
    const parent = await newParent();
    const res = await post(
      "/v1/onboarding/family",
      { familyName: "Another", parentName: "Parent", currency: "AUD" },
      parent.token,
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "ALREADY_IN_FAMILY");
  });

  test("a stranger cannot create a family for someone else's session", async () => {
    // No token at all: the bootstrap route is identity-gated, not open.
    const res = await app.inject({
      method: "POST",
      url: "/v1/onboarding/family",
      payload: { familyName: "Nope", parentName: "Nobody", currency: "AUD" },
    });
    assert.equal(res.statusCode, 401);
  });

  test("a parent adds a child and receives a join code", async () => {
    const parent = await newParent();
    const res = await post(
      "/v1/families/current/children",
      { displayName: "Maya" },
      parent.token,
    );
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.member.status, "invited");
    assert.match(body.joinCode, /^[A-HJ-NP-Z2-9]{6}$/);
  });

  test("a child cannot add a child", async () => {
    const parent = await newParent();
    const added = (
      await post("/v1/families/current/children", { displayName: "Maya" }, parent.token)
    ).json();

    const childToken = newToken();
    await post("/v1/join", { code: added.joinCode }, childToken);

    const res = await post(
      "/v1/families/current/children",
      { displayName: "Leo" },
      childToken,
    );
    assert.equal(res.statusCode, 403);
  });

  test("a join code works once and then stops working", async () => {
    const parent = await newParent();
    const added = (
      await post("/v1/families/current/children", { displayName: "Maya" }, parent.token)
    ).json();

    const first = await post("/v1/join", { code: added.joinCode }, newToken());
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().role, "child");

    const second = await post("/v1/join", { code: added.joinCode }, newToken());
    assert.equal(second.statusCode, 404);
  });

  test("an unknown code is indistinguishable from a spent one", async () => {
    const res = await post("/v1/join", { code: "ZZZZZZ" }, newToken());
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, "INVALID_CODE");
  });

  test("a child may set their own avatar", async () => {
    const parent = await newParent();
    const added = (
      await post("/v1/families/current/children", { displayName: "Maya" }, parent.token)
    ).json();
    const childToken = newToken();
    const joined = (await post("/v1/join", { code: added.joinCode }, childToken)).json();

    const res = await post(
      `/v1/members/${joined.memberId}/avatar`,
      { mascotId: "fox", style: "colour", version: 1 },
      childToken,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().avatarMascotId, "fox");
  });

  test("a child cannot set a sibling's avatar", async () => {
    const parent = await newParent();
    const maya = (
      await post("/v1/families/current/children", { displayName: "Maya" }, parent.token)
    ).json();
    const leo = (
      await post("/v1/families/current/children", { displayName: "Leo" }, parent.token)
    ).json();

    const mayaToken = newToken();
    await post("/v1/join", { code: maya.joinCode }, mayaToken);

    const res = await post(
      `/v1/members/${leo.member.id}/avatar`,
      { mascotId: "owl", style: "ink", version: 1 },
      mayaToken,
    );
    assert.equal(res.statusCode, 403);
  });

  test("a parent cannot set an avatar in another family", async () => {
    const ours = await newParent("Ours");
    const theirs = await newParent("Theirs");
    const theirChild = (
      await post("/v1/families/current/children", { displayName: "Theirs" }, theirs.token)
    ).json();

    const res = await post(
      `/v1/members/${theirChild.member.id}/avatar`,
      { mascotId: "fox", style: "colour", version: 1 },
      ours.token,
    );
    assert.equal(res.statusCode, 404);
  });

  test("an invalid avatar style is refused", async () => {
    const parent = await newParent();
    const me = (await get("/v1/me", parent.token)).json();
    const res = await post(
      `/v1/members/${me.memberId}/avatar`,
      { mascotId: "fox", style: "neon", version: 1 },
      parent.token,
    );
    assert.equal(res.statusCode, 400);
  });

  test("activating a PAL lets it own a request", async () => {
    const parent = await newParent();
    assert.equal(
      (await get("/v1/pals", parent.token)).json().pals.find((p: { id: string }) => p.id === "moneypal").active,
      false,
    );

    const res = await post("/v1/pals/moneypal/activate", {}, parent.token);
    assert.equal(res.statusCode, 200);

    assert.equal(
      (await get("/v1/pals", parent.token)).json().pals.find((p: { id: string }) => p.id === "moneypal").active,
      true,
    );
  });

  test("activation is idempotent", async () => {
    const parent = await newParent();
    await post("/v1/pals/tutorpal/activate", {}, parent.token);
    const again = await post("/v1/pals/tutorpal/activate", {}, parent.token);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().active, true);
  });

  test("a child cannot activate a PAL", async () => {
    const parent = await newParent();
    const added = (
      await post("/v1/families/current/children", { displayName: "Maya" }, parent.token)
    ).json();
    const childToken = newToken();
    await post("/v1/join", { code: added.joinCode }, childToken);

    const res = await post("/v1/pals/moneypal/activate", {}, childToken);
    assert.equal(res.statusCode, 403);
  });
});
