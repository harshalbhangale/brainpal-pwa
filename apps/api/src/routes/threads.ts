import { isParent } from "@brainpal/auth";
import { getDb, threadEvents, threads } from "@brainpal/database";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { ApiError } from "../errors.js";

const ThreadParams = z.object({ id: z.uuid() });

export async function registerThreadRoutes(app: FastifyInstance) {
  app.get("/v1/threads", async (request) => {
    const { principal } = request;
    const db = getDb();

    // A child sees only threads about themselves. Scoping happens in the query
    // so an unscoped row can never reach the serialiser.
    const scope = isParent(principal)
      ? eq(threads.familyId, principal.familyId)
      : and(
          eq(threads.familyId, principal.familyId),
          eq(threads.subjectMemberId, principal.memberId),
        );

    const rows = await db
      .select({
        id: threads.id,
        title: threads.title,
        ownerPal: threads.ownerPal,
        subjectMemberId: threads.subjectMemberId,
        updatedAt: threads.updatedAt,
      })
      .from(threads)
      .where(scope)
      .orderBy(desc(threads.updatedAt))
      .limit(50);

    return { threads: rows };
  });

  app.get("/v1/threads/:id", async (request) => {
    const { principal } = request;
    const { id } = ThreadParams.parse(request.params);
    const db = getDb();

    const [thread] = await db
      .select()
      .from(threads)
      .where(and(eq(threads.id, id), eq(threads.familyId, principal.familyId)))
      .limit(1);

    // Same 404 whether the thread belongs to another family or does not exist:
    // a distinct 403 would confirm that someone else's thread is real.
    if (!thread) {
      throw new ApiError(404, "THREAD_NOT_FOUND", "no such thread");
    }

    if (
      !isParent(principal) &&
      thread.subjectMemberId !== principal.memberId
    ) {
      throw new ApiError(404, "THREAD_NOT_FOUND", "no such thread");
    }

    const events = await db
      .select({
        id: threadEvents.id,
        actorType: threadEvents.actorType,
        actorMemberId: threadEvents.actorMemberId,
        actorPal: threadEvents.actorPal,
        kind: threadEvents.kind,
        body: threadEvents.body,
        payload: threadEvents.payload,
        createdAt: threadEvents.createdAt,
      })
      .from(threadEvents)
      .where(eq(threadEvents.threadId, thread.id))
      .orderBy(asc(threadEvents.createdAt));

    return {
      id: thread.id,
      title: thread.title,
      ownerPal: thread.ownerPal,
      subjectMemberId: thread.subjectMemberId,
      createdAt: thread.createdAt,
      events,
    };
  });
}
