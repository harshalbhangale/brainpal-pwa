import { randomInt, createHash, timingSafeEqual } from "node:crypto";

import { type Database, loginChallenges } from "@brainpal/database";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import { AuthError } from "./verifier.js";

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const CODE_DIGITS = 6;
const CODE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CODES_PER_WINDOW = 5;

/** Sends the login code to the parent. Swap for a real provider in production. */
export interface EmailSender {
  sendLoginCode(email: string, code: string): Promise<void>;
}

/** Logs the code instead of emailing it. Fine for local dev only. */
export class ConsoleEmailSender implements EmailSender {
  async sendLoginCode(email: string, code: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[magic-link] login code for ${email}: ${code}`);
  }
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
}

/**
 * Issues a one-time code to an email address. Always succeeds from the
 * caller's perspective — whether or not the address is real — so this can
 * never be used to enumerate who has an account.
 */
export async function requestLoginCode(
  db: Database,
  sender: EmailSender,
  email: string,
): Promise<void> {
  const normalised = email.trim().toLowerCase();

  // Every code is a real email we pay for and someone receives, so cap them per address.
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginChallenges)
    .where(
      and(
        eq(loginChallenges.email, normalised),
        gte(loginChallenges.createdAt, new Date(Date.now() - CODE_WINDOW_MS)),
      ),
    );
  if ((recent?.n ?? 0) >= MAX_CODES_PER_WINDOW) {
    throw new AuthError("TOO_MANY_REQUESTS", "too many codes requested");
  }

  const code = generateCode();

  await db.insert(loginChallenges).values({
    email: normalised,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  await sender.sendLoginCode(normalised, code);
}

/**
 * Verifies a one-time code and returns the email it was issued to. Attempts
 * are capped per challenge so the 6-digit space cannot be brute-forced, and
 * the comparison is constant-time so response latency cannot leak a match.
 */
export async function verifyLoginCode(
  db: Database,
  email: string,
  code: string,
): Promise<string> {
  const normalised = email.trim().toLowerCase();

  const [challenge] = await db
    .select()
    .from(loginChallenges)
    .where(
      and(eq(loginChallenges.email, normalised), isNull(loginChallenges.consumedAt)),
    )
    .orderBy(desc(loginChallenges.createdAt))
    .limit(1);

  if (!challenge || challenge.expiresAt <= new Date()) {
    throw new AuthError("INVALID_CODE", "that code has expired");
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    throw new AuthError("TOO_MANY_ATTEMPTS", "too many incorrect attempts");
  }

  const given = hashCode(code);
  const expected = challenge.codeHash;
  const matches =
    given.length === expected.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(expected));

  if (!matches) {
    await db
      .update(loginChallenges)
      .set({ attempts: challenge.attempts + 1 })
      .where(eq(loginChallenges.id, challenge.id));
    throw new AuthError("INVALID_CODE", "that code is incorrect");
  }

  await db
    .update(loginChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(loginChallenges.id, challenge.id));

  return normalised;
}
