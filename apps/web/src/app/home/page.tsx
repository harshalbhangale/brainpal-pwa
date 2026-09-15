"use client";

import { BrainPalAvatar } from "@brainpal/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  ApiError,
  api,
  clearToken,
  hasSignedIn,
  streamTurn,
  type Family,
  type Me,
} from "@/lib/api";

type PalId = "brainpal" | "moneypal" | "tutorpal";

interface Turn {
  question: string;
  ownerPal: PalId | null;
  answer: string;
  state: "routing" | "speaking" | "done" | "error";
  error?: string;
}

const PAL_LABEL: Record<PalId, string> = {
  brainpal: "BrainPal",
  moneypal: "MoneyPAL",
  tutorpal: "TutorPAL",
};

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [family, setFamily] = useState<Family | null>(null);
  const [text, setText] = useState("");
  const [turn, setTurn] = useState<Turn | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const busy = turn?.state === "routing" || turn?.state === "speaking";
  const answerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasSignedIn()) {
      router.replace("/login");
      return;
    }

    void (async () => {
      try {
        const [meResult, familyResult] = await Promise.all([
          api.get<Me>("/v1/me"),
          api.get<Family>("/v1/families/current"),
        ]);
        setMe(meResult);
        setFamily(familyResult);
      } catch (err) {
        if (err instanceof ApiError && err.code === "NO_MEMBERSHIP") {
          router.replace("/onboarding");
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
          router.replace("/login");
          return;
        }
        setLoadError(
          err instanceof ApiError ? err.message : "Could not load your family.",
        );
      }
    })();
  }, [router]);

  /**
   * `raw` comes from the input element when sending by keyboard. Reading state
   * instead would use the value as of the last render, which a fast typist can
   * beat — the keypress lands before React re-renders and the message is sent
   * short, or silently not at all.
   */
  async function ask(raw?: string) {
    const question = (raw ?? text).trim();
    if (!question || busy) return;

    setText("");
    setTurn({ question, ownerPal: null, answer: "", state: "routing" });

    for await (const event of streamTurn(question)) {
      if (event.type === "routed") {
        setTurn((t) =>
          t ? { ...t, ownerPal: event.ownerPal as PalId, state: "speaking" } : t,
        );
      } else if (event.type === "delta") {
        setTurn((t) => (t ? { ...t, answer: t.answer + event.text } : t));
        answerRef.current?.scrollTo({ top: answerRef.current.scrollHeight });
      } else if (event.type === "done") {
        setTurn((t) => (t ? { ...t, state: "done" } : t));
      } else if (event.type === "error") {
        setTurn((t) =>
          t
            ? {
                ...t,
                state: "error",
                error:
                  event.code === "AI_UNAVAILABLE"
                    ? "BrainPal is resting. The rest of the app still works."
                    : "That did not work. Try again in a moment.",
              }
            : t,
        );
      }
    }
  }

  const self = family?.members.find((m) => m.id === me?.memberId);
  const children = family?.members.filter((m) => m.role === "child") ?? [];

  const mascotState =
    turn?.state === "routing"
      ? "thinking"
      : turn?.state === "speaking"
        ? "speaking"
        : turn?.state === "error"
          ? "error"
          : turn?.state === "done"
            ? "success"
            : "idle";

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-5 py-8">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted">{family?.name ?? " "}</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Hello{me ? `, ${me.displayName}` : ""}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => {
            void api.post("/v1/auth/logout").catch(() => undefined);
            clearToken();
            router.replace("/login");
          }}
          className="text-sm text-muted underline underline-offset-4"
        >
          Sign out
        </button>
      </header>

      {loadError ? (
        <p role="alert" className="rounded-xl bg-card px-4 py-3 text-sm text-accent">
          {loadError}
        </p>
      ) : null}

      <section className="flex flex-col items-center gap-3 rounded-2xl bg-card p-6 shadow-sm">
        <BrainPalAvatar
          mascotId={self?.avatarMascotId ?? null}
          style={(self?.avatarStyle as "colour" | null) ?? null}
          version={self?.avatarVersion ?? null}
          name={me?.displayName ?? "You"}
          state={mascotState}
          size="large"
          interactive
        />
        {turn?.ownerPal ? (
          <p className="text-sm text-muted">
            {PAL_LABEL[turn.ownerPal]} is taking this one
          </p>
        ) : (
          <p className="text-sm text-muted">Ask me anything</p>
        )}
      </section>

      {turn ? (
        <section className="space-y-3 rounded-2xl bg-card p-5 shadow-sm">
          <p className="text-sm text-muted">{turn.question}</p>
          <div ref={answerRef} className="max-h-72 overflow-y-auto">
            {turn.state === "error" ? (
              <p role="alert" className="text-sm text-accent">
                {turn.error}
              </p>
            ) : (
              <p className="whitespace-pre-wrap leading-relaxed">
                {turn.answer}
                {busy ? <span className="animate-pulse">▍</span> : null}
              </p>
            )}
          </div>
        </section>
      ) : null}

      {children.length > 0 ? (
        <section className="space-y-3 rounded-2xl bg-card p-5 shadow-sm">
          <h2 className="text-sm font-medium">Your family</h2>
          <ul className="flex gap-4">
            {children.map((member) => (
              <li key={member.id} className="flex flex-col items-center gap-1">
                <BrainPalAvatar
                  mascotId={member.avatarMascotId}
                  style={member.avatarStyle as "colour" | null}
                  version={member.avatarVersion}
                  name={member.displayName}
                  size="medium"
                />
                <span className="text-xs text-muted">{member.displayName}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-auto flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // isComposing: while typing Japanese, Chinese or Korean, Enter
            // confirms the character being composed. Sending on it would cut
            // the message off mid-word.
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            void ask(e.currentTarget.value);
          }}
          placeholder="How can Maya save for a bike?"
          className="flex-1 rounded-xl border border-line bg-card px-4 py-3 outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void ask()}
          disabled={busy || text.trim().length === 0}
          className="rounded-xl bg-accent px-5 py-3 font-medium text-white disabled:opacity-40"
        >
          Ask
        </button>
      </div>
    </main>
  );
}
