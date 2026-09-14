/**
 * Turns a bearer token into an identity-provider subject. Nothing else: role
 * and family are never read from a token, only from `family_members`.
 *
 * Phase 1 ships the mock implementation so the agent loop can be built before
 * Cognito is wired. Swapping in the real verifier changes this file only.
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
