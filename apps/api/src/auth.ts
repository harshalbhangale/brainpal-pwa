import {
  AuthError,
  MockTokenVerifier,
  type Principal,
  type TokenVerifier,
  ensureUser,
  resolvePrincipal,
} from "@brainpal/auth";
import { getDb } from "@brainpal/database";
import type { FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
    /** Set by `identify`. Present without a principal only on bootstrap routes. */
    userId: string;
    authSubject: string;
  }
}

export function buildVerifier(): TokenVerifier {
  const mockEnabled =
    process.env["MOCK_AUTH"] === "true" &&
    process.env["NODE_ENV"] !== "production";

  if (mockEnabled) return new MockTokenVerifier();

  throw new Error(
    "No token verifier configured. Set MOCK_AUTH=true outside production, " +
      "or wire the Cognito verifier.",
  );
}

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new ApiError(401, "UNAUTHENTICATED", "missing bearer token");
  }
  return header.slice("Bearer ".length);
}

function toApiError(error: unknown): never {
  if (error instanceof AuthError) {
    const status = error.code === "NO_MEMBERSHIP" ? 403 : 401;
    throw new ApiError(status, error.code, error.message);
  }
  throw error;
}

/**
 * Identity only — who the caller is, with no claim about what they may see.
 *
 * Reserved for the bootstrap routes: creating a family and redeeming a join
 * code both have to happen before a membership exists. Every other route uses
 * `authenticate`.
 */
export function identify(verifier: TokenVerifier) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      const subject = await verifier.verify(bearer(request));
      request.authSubject = subject;
      request.userId = await ensureUser(getDb(), subject);
    } catch (error) {
      toApiError(error);
    }
  };
}

/**
 * Proves identity, then proves membership. A request that authenticates but
 * belongs to no active family member is rejected — there is no such thing as a
 * caller without a family scope.
 */
export function authenticate(verifier: TokenVerifier) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      const subject = await verifier.verify(bearer(request));
      request.authSubject = subject;
      request.principal = await resolvePrincipal(getDb(), subject);
      request.userId = request.principal.userId;
    } catch (error) {
      toApiError(error);
    }
  };
}
