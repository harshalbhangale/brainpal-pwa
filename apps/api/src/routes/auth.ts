import { randomUUID } from "node:crypto";

import {
  AuthError,
  ConsoleEmailSender,
  type EmailSender,
  createSession,
  ensureUser,
  requestLoginCode,
  revokeSession,
  verifyLoginCode,
  verifySessionToken,
} from "@brainpal/auth";
import { getDb } from "@brainpal/database";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { SESSION_COOKIE } from "../auth.js";
import { ApiError } from "../errors.js";

const RequestCode = z.object({ email: z.email() });
const VerifyCode = z.object({
  email: z.email(),
  code: z.string().length(6),
});

const isProduction = process.env["NODE_ENV"] === "production";

/**
 * Magic-link sign-in for parents. Unauthenticated by design — proving an
 * email inbox is the authentication event. Children never use this: they are
 * provisioned by a parent and sign in by redeeming a join code instead.
 */
export async function registerAuthRoutes(app: FastifyInstance) {
  const sender: EmailSender = new ConsoleEmailSender();

  app.post("/v1/auth/request-code", async (request, reply) => {
    const parsed = RequestCode.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "a valid email is required");
    }

    // Always 204, whether or not the address has an account: this endpoint
    // must never be usable to test which emails are registered.
    await requestLoginCode(getDb(), sender, parsed.data.email);
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
      if (error instanceof AuthError) {
        throw new ApiError(401, error.code, error.message);
      }
      throw error;
    }

    // The email itself is the authSubject: stable, unique, and it lets a
    // session resolve back to the same `resolvePrincipal` every other
    // verifier feeds, with no separate identity-provider concept needed.
    const userId = await ensureUser(db, email);
    const session = await createSession(db, userId, request.headers["user-agent"]);

    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
    });

    return { ok: true };
  });

  /**
   * A child never has an email or a password — a parent provisions them and
   * hands over a join code. This mints the device its own identity server
   * side (an opaque authSubject the child never sees or types) so the code
   * redemption below it has a session to attach to. No IdP is involved.
   */
  app.post("/v1/auth/device", async (_request, reply) => {
    const db = getDb();
    const authSubject = `device:${randomUUID()}`;
    const userId = await ensureUser(db, authSubject);
    const session = await createSession(db, userId, "device");

    reply.setCookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
      expires: session.expiresAt,
    });

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
