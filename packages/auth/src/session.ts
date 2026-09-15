import { randomBytes, createHash } from "node:crypto";

import { type Database, sessions } from "@brainpal/database";
import { and, eq, isNull } from "drizzle-orm";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The opaque token a client holds. Only its hash is ever persisted, so a
 * database read alone never yields a usable session.
 */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(
  db: Database,
  userId: string,
  deviceLabel?: string,
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ...(deviceLabel ? { deviceLabel } : {}),
    })
    .returning({ id: sessions.id });

  return { token, sessionId: row!.id, expiresAt };
}

/**
 * Verifies a session token and returns the user it belongs to, or null if the
 * token is unknown, expired, or revoked. Touches `lastSeenAt` on success —
 * best-effort, so a failed write here never fails the request it is serving.
 */
export async function verifySessionToken(
  db: Database,
  token: string,
): Promise<{ userId: string; sessionId: string } | null> {
  const tokenHash = hashToken(token);
  const now = new Date();

  const [row] = await db
    .select({ id: sessions.id, userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .limit(1);

  if (!row || row.expiresAt <= now) return null;

  await db
    .update(sessions)
    .set({ lastSeenAt: now })
    .where(eq(sessions.id, row.id))
    .catch(() => undefined);

  return { userId: row.userId, sessionId: row.id };
}

/** Revokes one session — "sign out this device" or "kick this device". */
export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

/** Revokes every session for a user — "sign out everywhere". */
export async function revokeAllSessions(db: Database, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
