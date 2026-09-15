import { type Database, providerEvents } from "@brainpal/database";
import { and, eq } from "drizzle-orm";

export interface ProviderEventInput {
  provider: string;
  eventId: string;
  type: string;
  familyId?: string | null | undefined;
  payload?: unknown;
}

/**
 * Records an inbound provider event exactly once. Providers redeliver webhooks,
 * so a duplicate is expected and reported, never processed a second time.
 */
export async function recordProviderEvent(
  db: Database,
  event: ProviderEventInput,
): Promise<{ id: string; duplicate: boolean }> {
  const [row] = await db
    .insert(providerEvents)
    .values({
      provider: event.provider,
      eventId: event.eventId,
      type: event.type,
      familyId: event.familyId ?? null,
      payload: event.payload ?? null,
    })
    .onConflictDoNothing({ target: [providerEvents.provider, providerEvents.eventId] })
    .returning({ id: providerEvents.id });
  if (row) return { id: row.id, duplicate: false };

  const [existing] = await db
    .select({ id: providerEvents.id })
    .from(providerEvents)
    .where(and(eq(providerEvents.provider, event.provider), eq(providerEvents.eventId, event.eventId)))
    .limit(1);
  return { id: existing!.id, duplicate: true };
}
