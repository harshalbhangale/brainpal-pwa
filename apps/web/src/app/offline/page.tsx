"use client";

import { useEffect, useState } from "react";

import { DeckReview } from "@/components/learn/DeckReview";
import { type SavedDeck, pendingReviewCount, savedDecks, syncReviews } from "@/lib/offline";

/**
 * Shown by the service worker for any page that cannot load without a
 * connection. Flashcard decks already opened on this device still work here.
 */
export default function Offline() {
  const [decks, setDecks] = useState<SavedDeck[]>([]);
  const [open, setOpen] = useState<SavedDeck | null>(null);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    setDecks(savedDecks());
    setPending(pendingReviewCount());
    const back = () => void syncReviews().then(setPending);
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-5 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">You are offline</h1>
        <p className="text-sm text-muted">
          BrainPal needs a connection for most things. Flashcards you have opened before still work.
        </p>
        {pending > 0 ? (
          <p className="text-sm text-tutor">
            {pending} review{pending === 1 ? "" : "s"} will sync when you are back online.
          </p>
        ) : null}
      </header>

      {open ? (
        <>
          <DeckReview key={open.id} deck={open} canGrade />
          <button
            type="button"
            onClick={() => {
              setOpen(null);
              setDecks(savedDecks());
              setPending(pendingReviewCount());
            }}
            className="text-sm text-muted underline underline-offset-4"
          >
            All saved decks
          </button>
        </>
      ) : decks.length > 0 ? (
        <section className="space-y-3 rounded-2xl bg-card p-5 shadow-sm">
          <h2 className="text-sm font-medium">Saved flashcards</h2>
          {decks.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setOpen(d)}
              className="flex w-full justify-between gap-3 rounded-xl bg-ground px-4 py-3 text-left"
            >
              <span className="min-w-0 truncate font-medium">{d.title}</span>
              <span className="shrink-0 text-sm text-muted">{d.cards.length} cards</span>
            </button>
          ))}
        </section>
      ) : null}

      <button type="button" onClick={() => window.location.reload()} className="text-sm text-muted underline underline-offset-4">
        Try again
      </button>
    </main>
  );
}
