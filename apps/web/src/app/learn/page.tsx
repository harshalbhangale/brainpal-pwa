"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  api,
  hasSignedIn,
  uploadLearningFile,
  type AttemptResult,
  type Deck,
  type Family,
  type LearningDocument,
  type LearningProgress,
  type LearningSource,
  type Me,
  type QuizView,
} from "@/lib/api";

type View =
  | { kind: "home" }
  | { kind: "document"; doc: LearningDocument }
  | { kind: "deck"; deck: Deck }
  | { kind: "quiz"; quiz: QuizView };

const card = "space-y-3 rounded-2xl bg-card p-5 shadow-sm";
const row = "rounded-xl bg-ground px-4 py-3";
const input = "w-full min-w-0 rounded-xl border border-line bg-ground px-3 py-2 outline-none focus:border-accent";
const primary = "shrink-0 rounded-xl bg-tutor px-4 py-2 font-medium text-white disabled:opacity-40";
const secondary = "shrink-0 rounded-xl border border-line px-4 py-2 font-medium disabled:opacity-40";

const NEXT_LABEL: Record<string, string> = {
  review_flashcards: "Review with flashcards",
  retry_quiz: "Try the quiz again",
  harder_quiz: "Try a harder quiz",
};

export default function Learn() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [children, setChildren] = useState<Array<{ id: string; displayName: string }>>([]);
  const [target, setTarget] = useState("");
  const [sources, setSources] = useState<LearningSource[]>([]);
  const [progress, setProgress] = useState<LearningProgress | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [cardIndex, setCardIndex] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<AttemptResult | null>(null);

  const parent = me?.role === "parent" || me?.role === "co_guardian";

  const loadHome = useCallback(async (who: Me, member: string) => {
    const [s, p] = await Promise.all([
      api.get<{ sources: LearningSource[] }>("/v1/learning/sources"),
      member ? api.get<LearningProgress>(`/v1/learning/progress?memberId=${member}`) : Promise.resolve(null),
    ]);
    setSources(who.role === "child" ? s.sources : s.sources.filter((x) => !member || x.ownerMemberId === member));
    setProgress(p);
  }, []);

  useEffect(() => {
    if (!hasSignedIn()) {
      router.replace("/login");
      return;
    }
    void (async () => {
      try {
        const [who, family] = await Promise.all([api.get<Me>("/v1/me"), api.get<Family>("/v1/families/current")]);
        setMe(who);
        const kids = family.members.filter((m) => m.role === "child").map((m) => ({ id: m.id, displayName: m.displayName }));
        setChildren(kids);
        const first = who.role === "child" ? who.memberId : (kids[0]?.id ?? "");
        setTarget(first);
        await loadHome(who, first);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        else setError(err instanceof ApiError ? err.message : "Could not load.");
      }
    })();
  }, [loadHome, router]);

  async function act(fn: () => Promise<void>, success?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const goHome = () =>
    act(async () => {
      setView({ kind: "home" });
      if (me) await loadHome(me, target);
    });

  const openDocument = (id: string) =>
    act(async () => {
      const doc = await api.get<LearningDocument>(`/v1/learning/documents/${id}`);
      setEdits({});
      setView({ kind: "document", doc });
    });

  const nameOf = (id: string) => children.find((c) => c.id === id)?.displayName ?? "";

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-5 py-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Learn</h1>
        {view.kind === "home" ? (
          <Link href="/home" className="text-sm text-muted underline underline-offset-4">
            Back home
          </Link>
        ) : (
          <button type="button" onClick={() => void goHome()} className="text-sm text-muted underline underline-offset-4">
            All material
          </button>
        )}
      </header>

      {notice ? <p className="rounded-xl bg-card px-4 py-3 text-sm text-tutor">{notice}</p> : null}
      {error ? (
        <p role="alert" className="rounded-xl bg-card px-4 py-3 text-sm text-accent">
          {error}
        </p>
      ) : null}

      {view.kind === "home" ? (
        <>
          {parent && children.length > 0 ? (
            <label className="flex items-center gap-3 text-sm">
              <span className="text-muted">For</span>
              <select
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  if (me) void loadHome(me, e.target.value);
                }}
                className={input}
              >
                {children.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <section className={card}>
            <h2 className="text-sm font-medium">Add learning material</h2>
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              aria-label="Worksheet, photo or PDF"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm"
            />
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is it? e.g. Maths worksheet" className={input} />
            <button
              type="button"
              disabled={busy || !file || title.trim().length === 0 || !target}
              className={primary}
              onClick={() =>
                void act(async () => {
                  const doc = await uploadLearningFile(file!, title.trim(), parent ? target : undefined);
                  setTitle("");
                  setFile(null);
                  setEdits({});
                  setView({ kind: "document", doc });
                }, "Read it. Check anything highlighted before making flashcards or a quiz.")
              }
            >
              {busy ? "Reading…" : "Upload and read"}
            </button>
            <p className="text-xs text-muted">A PDF or a photo, up to 10 MB. It stays private to your family.</p>
          </section>

          <section className={card}>
            <h2 className="text-sm font-medium">Material</h2>
            {sources.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : null}
            {sources.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={!s.documentId || busy}
                onClick={() => s.documentId && void openDocument(s.documentId)}
                className={`flex w-full justify-between gap-3 text-left ${row}`}
              >
                <span className="min-w-0 truncate font-medium">{s.title}</span>
                <span className="shrink-0 text-sm text-muted">
                  {parent ? `${nameOf(s.ownerMemberId)} · ` : ""}
                  {s.status === "failed" ? "Could not read" : s.kind.toUpperCase()}
                </span>
              </button>
            ))}
          </section>

          {progress && progress.progress.length > 0 ? (
            <section className={card}>
              <h2 className="text-sm font-medium">Progress</h2>
              {progress.progress.map((p) => (
                <div key={p.documentId} className={`space-y-2 ${row}`}>
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">{p.title}</span>
                    <span className="text-sm text-muted">{Math.round(p.mastery * 100)}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-line">
                    <div className="h-full bg-tutor" style={{ width: `${Math.round(p.mastery * 100)}%` }} />
                  </div>
                  <p className="text-xs text-muted">
                    Next: {NEXT_LABEL[p.nextStep.activity]} — {p.nextStep.reason}
                  </p>
                </div>
              ))}
            </section>
          ) : null}
        </>
      ) : null}

      {view.kind === "document" ? (
        <>
          <section className={card}>
            <h2 className="text-lg font-semibold">{view.doc.title}</h2>
            <p className="text-xs text-muted">
              {view.doc.method === "pdf_text" ? "Read from the PDF's own text." : "Read by TutorPAL from the image."}
            </p>
            {view.doc.needsReview > 0 ? (
              <p className="rounded-xl bg-ground px-4 py-3 text-sm text-accent">
                {view.doc.needsReview} part{view.doc.needsReview === 1 ? "" : "s"} could not be read clearly. Check{" "}
                {view.doc.needsReview === 1 ? "it" : "them"} below first.
              </p>
            ) : null}
            {view.doc.sections.map((s) => (
              <div key={s.id} className={`space-y-2 ${row} ${s.needsReview ? "ring-2 ring-accent" : ""}`}>
                <p className="text-xs text-muted">
                  {s.sourceRef}
                  {s.heading ? ` · ${s.heading}` : ""}
                  {s.corrected ? " · corrected" : ""}
                </p>
                {s.needsReview ? (
                  <>
                    <p className="text-sm text-accent">Could not read clearly: {s.uncertainParts.join(", ") || "some of this"}</p>
                    <textarea
                      value={edits[s.id] ?? s.text}
                      onChange={(e) => setEdits({ ...edits, [s.id]: e.target.value })}
                      rows={3}
                      aria-label="Corrected text"
                      className={input}
                    />
                    <button
                      type="button"
                      disabled={busy}
                      className={secondary}
                      onClick={() =>
                        void act(async () => {
                          const doc = await api.post<LearningDocument>(`/v1/learning/sections/${s.id}`, {
                            text: edits[s.id] ?? s.text,
                          });
                          setView({ kind: "document", doc });
                        }, "Saved.")
                      }
                    >
                      {edits[s.id] !== undefined && edits[s.id] !== s.text ? "Save correction" : "Looks right"}
                    </button>
                  </>
                ) : (
                  <p className="whitespace-pre-wrap">{s.text}</p>
                )}
              </div>
            ))}
          </section>

          <section className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || view.doc.needsReview > 0}
              className={primary}
              onClick={() =>
                void act(async () => {
                  const deck = await api.post<Deck>(`/v1/learning/documents/${view.doc.id}/flashcards`, { count: 10 });
                  setCardIndex(0);
                  setShowBack(false);
                  setView({ kind: "deck", deck });
                })
              }
            >
              Make flashcards
            </button>
            <button
              type="button"
              disabled={busy || view.doc.needsReview > 0}
              className={secondary}
              onClick={() =>
                void act(async () => {
                  const quiz = await api.post<QuizView>(`/v1/learning/documents/${view.doc.id}/quizzes`, { count: 5 });
                  setAnswers({});
                  setResult(null);
                  setView({ kind: "quiz", quiz });
                })
              }
            >
              Make a 5-question quiz
            </button>
          </section>
        </>
      ) : null}

      {view.kind === "deck"
        ? (() => {
            const current = view.deck.cards[cardIndex];
            if (!current) {
              return (
                <section className={card}>
                  <p className="font-medium">All done for now.</p>
                  <p className="text-sm text-muted">These cards will come back when they are due.</p>
                </section>
              );
            }
            return (
              <section className={card}>
                <p className="text-xs text-muted">
                  Card {cardIndex + 1} of {view.deck.cards.length}
                </p>
                <p className="text-lg font-semibold">{current.front}</p>
                {showBack ? (
                  <>
                    <p className="whitespace-pre-wrap rounded-xl bg-ground px-4 py-3">{current.back}</p>
                    {me?.memberId === view.deck.ownerMemberId ? (
                      <div className="flex flex-wrap gap-2">
                        {(["again", "hard", "good", "easy"] as const).map((grade) => (
                          <button
                            key={grade}
                            type="button"
                            disabled={busy}
                            className={grade === "good" ? primary : secondary}
                            onClick={() =>
                              void act(async () => {
                                await api.post(`/v1/learning/cards/${current.id}/review`, { grade });
                                setShowBack(false);
                                setCardIndex(cardIndex + 1);
                              })
                            }
                          >
                            {grade === "again" ? "Again" : grade === "hard" ? "Hard" : grade === "good" ? "Got it" : "Easy"}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <button type="button" className={secondary} onClick={() => { setShowBack(false); setCardIndex(cardIndex + 1); }}>
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
          })()
        : null}

      {view.kind === "quiz" ? (
        <>
          <section className={card}>
            <h2 className="text-lg font-semibold">{view.quiz.title}</h2>
            {view.quiz.questions.map((q, i) => {
              const outcome = result?.results.find((r) => r.questionId === q.id);
              return (
                <div key={q.id} className={`space-y-2 ${row}`}>
                  <p className="font-medium">
                    {i + 1}. {q.prompt}
                  </p>
                  {q.type === "mcq" && q.options ? (
                    <div className="flex flex-col gap-1">
                      {q.options.map((option) => (
                        <label key={option} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={q.id}
                            value={option}
                            disabled={Boolean(result)}
                            checked={answers[q.id] === option}
                            onChange={() => setAnswers({ ...answers, [q.id]: option })}
                          />
                          {option}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <input
                      value={answers[q.id] ?? ""}
                      disabled={Boolean(result)}
                      onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                      aria-label={`Answer to question ${i + 1}`}
                      className={input}
                    />
                  )}
                  {outcome ? (
                    <div className="space-y-1">
                      <p className={`text-sm font-medium ${outcome.correct ? "text-tutor" : "text-accent"}`}>
                        {outcome.correct ? "Right" : "Not quite"}
                        {outcome.needsReview ? " · a parent should check this mark" : ""}
                      </p>
                      <p className="text-sm">{outcome.feedback}</p>
                      {outcome.correctAnswer ? (
                        <p className="text-sm text-muted">Answer: {outcome.correctAnswer}</p>
                      ) : me?.memberId === view.quiz.ownerMemberId || parent ? (
                        <button
                          type="button"
                          disabled={busy}
                          className="text-sm underline underline-offset-4"
                          onClick={() =>
                            void act(async () => {
                              const revealed = await api.post<{ answer: string }>(`/v1/learning/attempts/${result!.attemptId}/reveal`, {
                                questionId: q.id,
                              });
                              setResult({
                                ...result!,
                                results: result!.results.map((r) =>
                                  r.questionId === q.id ? { ...r, correctAnswer: revealed.answer } : r,
                                ),
                              });
                            })
                          }
                        >
                          Show me the answer
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>

          {result ? (
            <section className={card}>
              <p className="text-lg font-semibold">
                {result.score} out of {result.total}
              </p>
              <p className="text-sm">
                Next: {NEXT_LABEL[result.nextStep.activity]} — {result.nextStep.reason}
              </p>
            </section>
          ) : me?.memberId === view.quiz.ownerMemberId ? (
            <button
              type="button"
              disabled={busy}
              className={primary}
              onClick={() =>
                void act(async () => {
                  const attempt = await api.post<AttemptResult>(`/v1/learning/quizzes/${view.quiz.id}/attempts`, {
                    answers: view.quiz.questions.map((q) => ({ questionId: q.id, answer: answers[q.id] ?? "" })),
                  });
                  setResult(attempt);
                })
              }
            >
              Check my answers
            </button>
          ) : (
            <p className="text-sm text-muted">Only {nameOf(view.quiz.ownerMemberId) || "the child"} can take this quiz.</p>
          )}
        </>
      ) : null}
    </main>
  );
}
