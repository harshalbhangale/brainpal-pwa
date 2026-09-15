"use client";

import { ApiError, api, type Deck } from "@/lib/api";

/**
 * Flashcards that keep working without a connection. Every deck opened is kept
 * on the device; a review made offline is queued with the time it happened and
 * a reference of its own, and sent when the connection comes back. The server
 * treats a second copy of the same reference as a replay, so sending the queue
 * twice is harmless.
 */

const DECKS_KEY = "brainpal.offline.decks";
const QUEUE_KEY = "brainpal.offline.reviews";
const MAX_DECKS = 20;

export type Grade = "again" | "hard" | "good" | "easy";

interface QueuedReview {
  deckId: string;
  cardId: string;
  grade: Grade;
  reviewedAt: string;
  clientRef: string;
}

export interface SavedDeck extends Deck {
  savedAt: string;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the app still works online.
  }
}

export function savedDecks(): SavedDeck[] {
  return read<SavedDeck[]>(DECKS_KEY, []);
}

export function saveDeckOffline(deck: Deck): void {
  const others = savedDecks().filter((d) => d.id !== deck.id);
  write(DECKS_KEY, [{ ...deck, savedAt: new Date().toISOString() }, ...others].slice(0, MAX_DECKS));
}

export function pendingReviewCount(): number {
  return read<QueuedReview[]>(QUEUE_KEY, []).length;
}

/** Keeps the saved copy roughly in step, so an offline session does not show a card again straight away. */
function markLocally(deckId: string, cardId: string, grade: Grade, at: string): void {
  const decks = savedDecks();
  const deck = decks.find((d) => d.id === deckId);
  const card = deck?.cards.find((c) => c.id === cardId);
  if (!card) return;
  card.dueAt = new Date(new Date(at).getTime() + (grade === "again" ? 10 * 60_000 : 86_400_000)).toISOString();
  write(DECKS_KEY, decks);
}

/** One path online and off: send it now if possible, otherwise queue it. */
export async function reviewAnywhere(deckId: string, cardId: string, grade: Grade): Promise<"sent" | "queued"> {
  const review: QueuedReview = { deckId, cardId, grade, reviewedAt: new Date().toISOString(), clientRef: crypto.randomUUID() };
  markLocally(deckId, cardId, grade, review.reviewedAt);
  try {
    await send(review);
    return "sent";
  } catch (error) {
    if (!(error instanceof ApiError) || error.status === 0) {
      write(QUEUE_KEY, [...read<QueuedReview[]>(QUEUE_KEY, []), review]);
      return "queued";
    }
    throw error;
  }
}

const send = (r: QueuedReview) =>
  api.post(`/v1/learning/cards/${r.cardId}/review`, { grade: r.grade, reviewedAt: r.reviewedAt, clientRef: r.clientRef });

let syncing: Promise<number> | null = null;

/** Sends queued reviews in order. Returns how many are still waiting. */
export function syncReviews(): Promise<number> {
  syncing ??= (async () => {
    const queue = read<QueuedReview[]>(QUEUE_KEY, []);
    let i = 0;
    for (; i < queue.length; i++) {
      try {
        await send(queue[i]!);
      } catch (error) {
        // Offline, signed out, or the server struggling: stop and keep the rest for later.
        // Anything else (the card was deleted) will never succeed, so it is dropped.
        const status = error instanceof ApiError ? error.status : 0;
        if (status === 0 || status === 401 || status === 429 || status >= 500) break;
      }
    }
    const left = queue.slice(i);
    // Reviews queued while this ran are kept too.
    const now = read<QueuedReview[]>(QUEUE_KEY, []);
    write(QUEUE_KEY, [...left, ...now.slice(queue.length)]);
    return left.length + now.length - queue.length;
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}
