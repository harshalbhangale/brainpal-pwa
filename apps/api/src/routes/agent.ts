import { AgentTurnRequest } from "@brainpal/contracts";
import {
  type TurnEvent,
  modelsConfigured,
  runTurn,
} from "@brainpal/brainpal";
import {
  agentRuns,
  getDb,
  palActivations,
  threadEvents,
  threads,
} from "@brainpal/database";
import { ledgerFacts } from "@brainpal/moneypal";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { allowedOrigins } from "../app.js";
import { ApiError } from "../errors.js";

async function activePalsFor(familyId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ palId: palActivations.palId })
    .from(palActivations)
    .where(
      and(
        eq(palActivations.familyId, familyId),
        eq(palActivations.active, true),
      ),
    );
  return new Set(rows.map((r) => r.palId));
}

export async function registerAgentRoutes(app: FastifyInstance) {
  app.post("/v1/agent/turn", async (request, reply) => {
    const { principal } = request;
    const parsed = AgentTurnRequest.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_REQUEST", "bad turn request", {
        issues: parsed.error.issues,
      });
    }

    const db = getDb();
    const { text } = parsed.data;

    // A child's thread is always about themselves. A parent's is about the
    // family until a subject is named, which Phase 2 introduces.
    const subjectMemberId =
      principal.role === "child" ? principal.memberId : null;

    let threadId = parsed.data.threadId;
    if (threadId) {
      const [existing] = await db
        .select({ id: threads.id, subjectMemberId: threads.subjectMemberId })
        .from(threads)
        .where(
          and(
            eq(threads.id, threadId),
            eq(threads.familyId, principal.familyId),
          ),
        )
        .limit(1);

      if (!existing) throw new ApiError(404, "THREAD_NOT_FOUND", "no such thread");
      if (
        principal.role === "child" &&
        existing.subjectMemberId !== principal.memberId
      ) {
        throw new ApiError(404, "THREAD_NOT_FOUND", "no such thread");
      }
    }

    // Checked after validation and ownership: whether the model layer is up has
    // no bearing on whether this caller may touch this thread, and answering
    // 503 first would tell them a thread they cannot see is real.
    //
    // Rule 9: an honest, stated failure rather than a 500 when AI is down.
    if (!modelsConfigured()) {
      throw new ApiError(
        503,
        "AI_UNAVAILABLE",
        "BrainPal is not available right now. The screens still work.",
      );
    }

    const [run] = await db
      .insert(agentRuns)
      .values({
        familyId: principal.familyId,
        actorMemberId: principal.memberId,
        contractVersion: "1",
        inputText: text,
        status: "running",
        ...(threadId ? { threadId } : {}),
      })
      .returning();
    const runId = run!.id;

    reply.raw.setHeader("content-type", "text/event-stream");
    reply.raw.setHeader("cache-control", "no-cache");
    reply.raw.setHeader("connection", "keep-alive");
    reply.raw.setHeader("x-request-id", String(request.id));

    // Writing to reply.raw skips the reply lifecycle that @fastify/cors hooks
    // into, so without this the browser rejects the whole stream for a missing
    // Access-Control-Allow-Origin — while curl, which ignores CORS, works fine.
    // The origin is still checked against the same allowlist.
    const origin = request.headers.origin;
    if (origin && allowedOrigins().includes(origin)) {
      reply.raw.setHeader("access-control-allow-origin", origin);
      reply.raw.setHeader("access-control-allow-credentials", "true");
      reply.raw.setHeader("vary", "origin");
    }

    reply.raw.flushHeaders();

    const send = (event: TurnEvent, thread?: string) => {
      const payload: Record<string, unknown> = { ...event };
      if (thread) payload["threadId"] = thread;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const activePals = await activePalsFor(principal.familyId);

    // Best-effort: a ledger read failing must not stop MoneyPAL answering. It
    // then has no facts, and its instructions say to admit that rather than guess.
    const moneyFacts = activePals.has("moneypal")
      ? await ledgerFacts(db, {
          memberId: principal.memberId,
          familyId: principal.familyId,
          role: principal.role,
        }).catch(() => undefined)
      : undefined;

    try {
      for await (const event of runTurn({
        text,
        speakerName: principal.displayName,
        speakerRole: principal.role,
        activePals,
        ...(moneyFacts ? { moneyFacts } : {}),
      })) {
        if (event.type === "routed" && !threadId) {
          // The thread is created once the owning PAL is known, so it is never
          // filed under the wrong PAL.
          const [thread] = await db
            .insert(threads)
            .values({
              familyId: principal.familyId,
              ownerPal: event.ownerPal,
              title: text.slice(0, 80),
              ...(subjectMemberId ? { subjectMemberId } : {}),
            })
            .returning();
          threadId = thread!.id;

          await db.insert(threadEvents).values({
            threadId,
            familyId: principal.familyId,
            actorType: "member",
            actorMemberId: principal.memberId,
            kind: "message.sent",
            body: text,
          });

          await db
            .update(agentRuns)
            .set({ threadId, ownerPal: event.ownerPal, intent: event.intent })
            .where(eq(agentRuns.id, runId));
        }

        if (event.type === "done" && threadId) {
          await db.insert(threadEvents).values({
            threadId,
            familyId: principal.familyId,
            actorType: "pal",
            actorPal: event.result.ownerPal,
            kind: "message.received",
            body: event.result.message,
          });

          await db
            .update(agentRuns)
            .set({
              status: "succeeded",
              responseType: event.result.responseType,
              modelRole: event.usage.modelRole,
              model: event.usage.model,
              inputTokens: event.usage.inputTokens ?? null,
              outputTokens: event.usage.outputTokens ?? null,
              latencyMs: event.usage.latencyMs,
              completedAt: new Date(),
            })
            .where(eq(agentRuns.id, runId));
        }

        if (event.type === "error") {
          await db
            .update(agentRuns)
            .set({
              status: "failed",
              errorCode: event.code,
              errorMessage: event.message,
              completedAt: new Date(),
            })
            .where(eq(agentRuns.id, runId));
        }

        send(event, threadId);
      }
    } catch (error) {
      request.log.error({ err: error, runId }, "turn failed");
      await db
        .update(agentRuns)
        .set({
          status: "failed",
          errorCode: "INTERNAL",
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
      send({ type: "error", code: "INTERNAL", message: "the turn failed" });
    } finally {
      reply.raw.end();
    }

    return reply;
  });
}
