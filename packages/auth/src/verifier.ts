import type { Database } from "@brainpal/database";

import { authSubjectForUser } from "./principal.js";
import { verifySessionToken } from "./session.js";

/**
 * Turns a bearer token into an identity-provider subject. Nothing else: role
 * and family are never read from a token, only from `family_members`.
 *
 * Phase 1 shipped a mock implementation so the agent loop could be built
 * before real sign-in existed. `SessionTokenVerifier` below is the real one.
 */
export interface TokenVerifier {
  verify(token: string): Promise<string>;
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const MOCK_PREFIX = "mock:";

/**
 * Accepts `mock:<subject>` and returns the subject verbatim.
 *
 * Refuses to construct under NODE_ENV=production. That check is here rather
 * than at the call site so there is no route left that can opt out of it.
 */
export class MockTokenVerifier implements TokenVerifier {
  constructor() {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error("MockTokenVerifier must never be used in production");
    }
  }

  async verify(token: string): Promise<string> {
    if (!token.startsWith(MOCK_PREFIX)) {
      throw new AuthError("INVALID_TOKEN", "expected a mock token");
    }
    const subject = token.slice(MOCK_PREFIX.length).trim();
    if (!subject) {
      throw new AuthError("INVALID_TOKEN", "mock token has no subject");
    }
    return subject;
  }
}

export function mockToken(subject: string): string {
  return `${MOCK_PREFIX}${subject}`;
}

/**
 * The production verifier: a session token (see `session.ts`) resolves to the
 * user it belongs to, then to that user's authSubject, so it feeds the same
 * `resolvePrincipal` call every other verifier does.
 */
export class SessionTokenVerifier implements TokenVerifier {
  constructor(private readonly db: Database) {}

  async verify(token: string): Promise<string> {
    const session = await verifySessionToken(this.db, token);
    if (!session) {
      throw new AuthError("INVALID_TOKEN", "session is invalid or expired");
    }
    return authSubjectForUser(this.db, session.userId);
  }
}
