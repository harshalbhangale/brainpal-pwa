import { pgEnum } from "drizzle-orm/pg-core";

export const familyRole = pgEnum("family_role", [
  "parent",
  "co_guardian",
  "child",
]);

export const memberStatus = pgEnum("member_status", [
  "invited",
  "active",
  "removed",
]);

export const avatarStyle = pgEnum("avatar_style", [
  "colour",
  "ink",
  "sketch",
  "riso",
  "paper",
  "pixel",
]);

export const palId = pgEnum("pal_id", ["brainpal", "moneypal", "tutorpal"]);

export const actorType = pgEnum("actor_type", ["member", "pal", "system"]);

export const responseType = pgEnum("response_type", [
  "message",
  "question",
  "proposal",
  "progress",
  "error",
]);

export const runStatus = pgEnum("run_status", [
  "running",
  "succeeded",
  "failed",
]);
