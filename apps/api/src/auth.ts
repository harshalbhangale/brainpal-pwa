import {
  AuthError,
  MockTokenVerifier,
  type Principal,
  type TokenVerifier,
  resolvePrincipal,
} from "@brainpal/auth";
import { getDb } from "@brainpal/database";
import type { FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
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

/**
 * Proves identity, then proves membership. A request that authenticates but
 * belongs to no active family member is rejected — there is no such thing as a
 * caller without a family scope.
 */
export function authenticate(verifier: TokenVerifier) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new ApiError(401, "UNAUTHENTICATED", "missing bearer token");
    }

    try {
      const subject = await verifier.verify(header.slice("Bearer ".length));
      request.principal = await resolvePrincipal(getDb(), subject);
    } catch (error) {
      if (error instanceof AuthError) {
        const status = error.code === "NO_MEMBERSHIP" ? 403 : 401;
        throw new ApiError(status, error.code, error.message);
      }
      throw error;
    }
  };
}
