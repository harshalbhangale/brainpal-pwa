"use client";

import { useState } from "react";

import { ApiError, type Deck } from "@/lib/api";
import { type Grade, reviewAnywhere } from "@/lib/offline";

const card = "space-y-3 rounded-2xl bg-card p-5 shadow-sm";
const primary = "shrink-0 rounded-xl bg-tutor px-4 py-2 font-medium text-white disabled:opacity-40";
const secondary = "shrink-0 rounded-xl border border-line px-4 py-2 font-medium disabled:opacity-40";

const LABEL: Record<Grade, string> = { again: "Again", hard: "Hard", good: "Got it", easy: "Easy" };

/** Cards that are due come first; with none due, the whole deck is there to practise. */
export function DeckReview({ deck, canGrade, onError }: { deck: Deck; canGrade: boolean; onError?: (message: string) => void }) {
  const [queue] = useState(() => {
    const now = Date.now();
    const due = deck.cards.filter((c) => new Date(c.dueAt).getTime() <= now);
    return { cards: due.length > 0 ? due : deck.cards, practising: due.length === 0 };
  });
  const [index, setIndex] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);

  const current = queue.cards[index];
  const next = () => {
    setShowBack(false);
    setIndex(index + 1);
  };

  if (!current) {
    return (
      <section className={card}>
        <p className="font-medium">All done for now.</p>
        <p className="text-sm text-muted">
          {queued > 0
            ? `${queued} review${queued === 1 ? " is" : "s are"} saved on this device and will sync when you are back online.`
            : "These cards will come back when they are due."}
        </p>
      </section>
    );
  }

  return (
    <section className={card}>
      <p className="text-xs text-muted">
        Card {index + 1} of {queue.cards.length}
        {queue.practising ? " · nothing due, practising anyway" : ""}
      </p>
      <p className="text-lg font-semibold">{current.front}</p>
      {showBack ? (
        <>
          <p className="whitespace-pre-wrap rounded-xl bg-ground px-4 py-3">{current.back}</p>
          {canGrade ? (
            <div className="flex flex-wrap gap-2">
              {(["again", "hard", "good", "easy"] as const).map((grade) => (
                <button
                  key={grade}
                  type="button"
                  disabled={busy}
                  className={grade === "good" ? primary : secondary}
                  onClick={() =>
                    void (async () => {
                      setBusy(true);
                      try {
                        if ((await reviewAnywhere(deck.id, current.id, grade)) === "queued") setQueued((n) => n + 1);
                        next();
                      } catch (err) {
                        onError?.(err instanceof ApiError ? err.message : "That did not save. Try again.");
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  {LABEL[grade]}
                </button>
              ))}
            </div>
          ) : (
            <button type="button" className={secondary} onClick={next}>
              Next card
            </button>
          )}
        </>
      ) : (
        <button type="button" className={primary} onClick={() => setShowBack(true)}>
          Show answer
        </button>
      )}
    </section>
  );
}
