import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";

import { authenticate, buildVerifier, identify } from "./auth.js";
import { ApiError, type ErrorEnvelope } from "./errors.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerFamilyRoutes } from "./routes/families.js";
import { registerHealthRoutes } from "./routes/health.js";
import {
  registerBootstrapRoutes,
  registerFamilyWriteRoutes,
} from "./routes/onboarding.js";
import { registerPalRoutes } from "./routes/pals.js";
import { registerThreadRoutes } from "./routes/threads.js";

export const SERVICE_NAME = "brainpal-api";
export const SERVICE_VERSION = "0.1.0";

/**
 * Exported because the streaming turn writes to `reply.raw` and so must apply
 * these itself: raw writes bypass the reply lifecycle @fastify/cors hooks into.
 */
export function allowedOrigins(): string[] {
  const configured = process.env["ALLOWED_ORIGINS"];
  if (configured) return configured.split(",").map((o) => o.trim());
  if (process.env["NODE_ENV"] === "production") return [];
  return ["http://localhost:3000"];
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
      // Never log tokens or child conversation content.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    genReqId: (req) =>
      (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
  });

  await app.register(cors, {
    origin: allowedOrigins(),
    credentials: true,
    allowedHeaders: ["content-type", "authorization", "x-request-id"],
  });

  await app.register(rateLimit, {
    max: Number(process.env["RATE_LIMIT_MAX"] ?? 120),
    timeWindow: "1 minute",
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);

    if (error instanceof ApiError) {
      request.log.warn({ code: error.code, requestId }, error.message);
      const body: ErrorEnvelope = {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
      return reply.status(error.status).send(body);
    }

    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? (error as { statusCode?: number }).statusCode
        : undefined;

    if (statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "too many requests",
          requestId,
        },
      } satisfies ErrorEnvelope);
    }

    request.log.error({ err: error, requestId }, "unhandled error");
    return reply.status(500).send({
      error: {
        code: "INTERNAL",
        message: "something went wrong",
        requestId,
      },
    } satisfies ErrorEnvelope);
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", String(request.id));
  });

  // Public. Registered before the auth hook so a health probe needs no token
  // and no database.
  await app.register(registerHealthRoutes);

  const verifier = buildVerifier();

  // Identity but no membership: the two routes that must run before a
  // membership can exist. Each establishes its own authorisation.
  await app.register(async (bootstrapScope) => {
    bootstrapScope.addHook("preHandler", identify(verifier));
    await bootstrapScope.register(registerBootstrapRoutes);
  });

  await app.register(async (protectedScope) => {
    protectedScope.addHook("preHandler", authenticate(verifier));
    await protectedScope.register(registerAgentRoutes);
    await protectedScope.register(registerFamilyRoutes);
    await protectedScope.register(registerFamilyWriteRoutes);
    await protectedScope.register(registerPalRoutes);
    await protectedScope.register(registerThreadRoutes);
  });

  return app;
}
