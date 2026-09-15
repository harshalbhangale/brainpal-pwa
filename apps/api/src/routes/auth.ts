import { randomUUID } from "node:crypto";

import {
  AuthError,
  type CreatedSession,
  createSession,
  ensureUser,
  requestLoginCode,
  revokeSession,
  verifyLoginCode,
  verifySessionToken,
} from "@brainpal/auth";
import { getDb } from "@brainpal/database";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import { SESSION_COOKIE } from "../auth.js";
import { buildEmailSender } from "../email.js";
import { ApiError } from "../errors.js";

const RequestCode = z.object({ email: z.email() });
const VerifyCode = z.object({
  email: z.email(),
  code: z.string().length(6),
});
const GoogleCredential = z.object({ credential: z.string().min(20).max(4096) });

const isProduction = process.env["NODE_ENV"] === "production";
const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function setSessionCookie(reply: FastifyReply, session: CreatedSession): void {
  reply.setCookie(SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
}

/**
 * Parent sign-in: Google, or a 6-digit code emailed to them. Both prove an
 * email address and land on the same account, keyed by that address.
 * Children never use either: a parent provisions them and they join by code.
 */
export async function registerAuthRoutes(app: FastifyInstance) {
  const sender = buildEmailSender();

  app.post("/v1/auth/request-code", async (request, reply) => {
    const parsed = RequestCode.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "a valid email is required");
    }
    try {
      // 204 whether or not the address has an account: this endpoint must
      // never be usable to test which emails are registered.
      await requestLoginCode(getDb(), sender, parsed.data.email);
    } catch (error) {
      if (error instanceof AuthError && error.code === "TOO_MANY_REQUESTS") {
        throw new ApiError(429, error.code, "Too many codes asked for. Try again in a few minutes.");
      }
      request.log.error({ err: error }, "login code could not be sent");
      throw new ApiError(502, "EMAIL_FAILED", "We could not send the code. Try again in a moment.");
    }
    return reply.status(204).send();
  });

  app.post("/v1/auth/verify", async (request, reply) => {
    const parsed = VerifyCode.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "email and a 6-digit code are required");
    }

    const db = getDb();
    let email: string;
    try {
      email = await verifyLoginCode(db, parsed.data.email, parsed.data.code);
    } catch (error) {
      if (error instanceof AuthError) throw new ApiError(401, error.code, error.message);
      throw error;
    }

    const userId = await ensureUser(db, email);
    setSessionCookie(reply, await createSession(db, userId, request.headers["user-agent"]));
    return { ok: true };
  });

  app.post("/v1/auth/google", async (request, reply) => {
    const clientId = process.env["GOOGLE_CLIENT_ID"];
    if (!clientId) throw new ApiError(503, "GOOGLE_NOT_CONFIGURED", "Google sign-in is not set up yet.");

    const parsed = GoogleCredential.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, "INVALID_REQUEST", "a Google credential is required");

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(parsed.data.credential, GOOGLE_KEYS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: clientId,
      }));
    } catch {
      throw new ApiError(401, "INVALID_GOOGLE_TOKEN", "Google sign-in could not be verified.");
    }
    if (payload["email_verified"] !== true || typeof payload["email"] !== "string") {
      throw new ApiError(401, "EMAIL_NOT_VERIFIED", "That Google account has no verified email.");
    }

    // The same key as the email-code path, so either sign-in reaches one account.
    const db = getDb();
    const userId = await ensureUser(db, payload["email"].toLowerCase());
    setSessionCookie(reply, await createSession(db, userId, request.headers["user-agent"]));
    return { ok: true };
  });

  /**
   * A child never has an email or a password. This mints the device its own
   * identity server side, so the join-code redemption has a session to attach
   * to. No identity provider is involved.
   */
  app.post("/v1/auth/device", async (_request, reply) => {
    const db = getDb();
    const userId = await ensureUser(db, `device:${randomUUID()}`);
    setSessionCookie(reply, await createSession(db, userId, "device"));
    return { ok: true };
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const session = await verifySessionToken(getDb(), token);
      if (session) await revokeSession(getDb(), session.sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.status(204).send();
  });
}
