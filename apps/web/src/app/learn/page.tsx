"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { CheatsheetView } from "@/components/learn/CheatsheetView";
import { DeckReview } from "@/components/learn/DeckReview";
import { InterviewView } from "@/components/learn/InterviewView";
import { Timetable } from "@/components/learn/Timetable";
import {
  ApiError,
  api,
  hasSignedIn,
  uploadLearningFile,
  type AttemptResult,
  type Cheatsheet,
  type Deck,
  type DeckSummary,
  type Family,
  type Interview,
  type InterviewSummary,
  type LearningDocument,
  type LearningProgress,
  type LearningSource,
  type Me,
  type QuizView,
  type SourceKind,
  type StudentProfile,
} from "@/lib/api";
import { saveDeckOffline, syncReviews } from "@/lib/offline";

type View =
  | { kind: "home" }
  | { kind: "document"; doc: LearningDocument }
  | { kind: "deck"; deck: Deck }
  | { kind: "quiz"; quiz: QuizView }
  | { kind: "cheatsheet"; sheet: Cheatsheet }
  | { kind: "interview"; interview: Interview };

type AddMode = "file" | "youtube" | "text";

const card = "space-y-3 rounded-2xl bg-card p-5 shadow-sm";
const row = "rounded-xl bg-ground px-4 py-3";
const input = "w-full min-w-0 rounded-xl border border-line bg-ground px-3 py-2 outline-none focus:border-accent";
const primary = "shrink-0 rounded-xl bg-tutor px-4 py-2 font-medium text-white disabled:opacity-40";
const secondary = "shrink-0 rounded-xl border border-line px-4 py-2 font-medium disabled:opacity-40";
const tab = (on: boolean) => `rounded-lg px-3 py-1.5 text-sm ${on ? "bg-tutor text-white" : "text-muted"}`;

const NEXT_LABEL: Record<string, string> = {
  review_flashcards: "Review with flashcards",
  retry_quiz: "Try the quiz again",
  harder_quiz: "Try a harder quiz",
};

const KIND_LABEL: Record<SourceKind, string> = { pdf: "PDF", image: "Photo", youtube: "Video", text: "Notes" };

const METHOD_LABEL: Record<string, string> = {
  pdf_text: "Read from the PDF's own text.",
  vision: "Read by TutorPAL from the image.",
  text: "From pasted notes.",
  youtube_captions: "From the video's captions.",
  youtube_auto_captions: "From the video's automatic captions, which can mishear. Fix anything that looks wrong.",
};

export default function Learn() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [children, setChildren] = useState<Array<{ id: string; displayName: string }>>([]);
  const [target, setTarget] = useState("");
  const [sources, setSources] = useState<LearningSource[]>([]);
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [sheets, setSheets] = useState<Array<Omit<Cheatsheet, "blocks">>>([]);
  const [interviews, setInterviews] = useState<InterviewSummary[]>([]);
  const [progress, setProgress] = useState<LearningProgress | null>(null);
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [mode, setMode] = useState<AddMode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [videoLink, setVideoLink] = useState("");
  const [notes, setNotes] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<AttemptResult | null>(null);

  const parent = me?.role === "parent" || me?.role === "co_guardian";

  const loadHome = useCallback(async (who: Me, member: string) => {
    const [s, d, c, i, p, prof] = await Promise.all([
      api.get<{ sources: LearningSource[] }>("/v1/learning/sources"),
      api.get<{ decks: DeckSummary[] }>("/v1/learning/decks"),
      api.get<{ cheatsheets: Array<Omit<Cheatsheet, "blocks">> }>("/v1/learning/cheatsheets"),
      api.get<{ interviews: InterviewSummary[] }>("/v1/learning/interviews"),
      member ? api.get<LearningProgress>(`/v1/learning/progress?memberId=${member}`) : Promise.resolve(null),
      member ? api.get<StudentProfile>(`/v1/learning/profiles/${member}`) : Promise.resolve(null),
    ]);
    // A parent sees the whole family's material; the page shows one child at a time.
    const theirs = (owner: string) => who.role === "child" || !member || owner === member;
    setSources(s.sources.filter((x) => theirs(x.ownerMemberId)));
    setDecks(d.decks.filter((x) => theirs(x.ownerMemberId)));
    setSheets(c.cheatsheets.filter((x) => theirs(x.ownerMemberId)));
    setInterviews(i.interviews.filter((x) => theirs(x.memberId)));
    setProgress(p);
    setProfile(prof);
    setSubjectId("");
  }, []);

  useEffect(() => {
    if (!hasSignedIn()) {
      router.replace("/login");
      return;
    }
    // Flashcard reviews made offline go up as soon as there is a connection.
    void syncReviews();
    const back = () => void syncReviews();
    window.addEventListener("online", back);
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
        else if (err instanceof ApiError && err.status === 0) router.replace("/offline");
        else setError(err instanceof ApiError ? err.message : "Could not load.");
      }
    })();
    return () => window.removeEventListener("online", back);
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

  const openDeck = (deck: Deck) => {
    saveDeckOffline(deck);
    setView({ kind: "deck", deck });
  };

  const nameOf = (id: string) => children.find((c) => c.id === id)?.displayName ?? "";
  const filing = () => ({
    ...(parent && target ? { memberId: target } : {}),
    ...(subjectId ? { subjectId } : {}),
  });

  const added = (doc: LearningDocument) => {
    setTitle("");
    setFile(null);
    setVideoLink("");
    setNotes("");
    setEdits({});
    setView({ kind: "document", doc });
  };

  const canAdd =
    Boolean(target) &&
    (mode === "file" ? Boolean(file) && title.trim().length > 0 : mode === "youtube" ? videoLink.trim().length > 0 : notes.trim().length > 0 && title.trim().length > 0);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-5 py-8">
      <header className="flex items-center justify-between print:hidden">
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
                  if (me) void act(() => loadHome(me, e.target.value));
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
            <div className="flex gap-1 rounded-xl bg-ground p-1" role="tablist">
              {(
                [
                  ["file", "Photo or PDF"],
                  ["youtube", "YouTube"],
                  ["text", "Notes"],
                ] as const
              ).map(([m, label]) => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} className={tab(mode === m)} onClick={() => setMode(m)}>
                  {label}
                </button>
              ))}
            </div>

            {/* Keyed: without it React reuses one <input> across modes and it flips from uncontrolled to controlled. */}
            {mode === "file" ? (
              <input
                key="file"
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                aria-label="Worksheet, photo or PDF"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm"
              />
            ) : mode === "youtube" ? (
              <input key="youtube" value={videoLink} onChange={(e) => setVideoLink(e.target.value)} placeholder="Paste a YouTube link" inputMode="url" className={input} />
            ) : (
              <textarea key="text" value={notes} onChange={(e) => setNotes(e.target.value)} rows={5} placeholder="Paste notes, or a video's transcript" className={input} />
            )}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={mode === "youtube" ? "Title (optional: we use the video's)" : "What is it? e.g. Maths worksheet"}
              className={input}
            />
            {profile && profile.subjects.length > 0 ? (
              <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} aria-label="Subject" className={input}>
                <option value="">No subject</option>
                {profile.subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              disabled={busy || !canAdd}
              className={primary}
              onClick={() =>
                void act(async () => {
                  const f = filing();
                  const doc =
                    mode === "file"
                      ? await uploadLearningFile(file!, title.trim(), f.memberId, f.subjectId)
                      : mode === "youtube"
                        ? await api.post<LearningDocument>("/v1/learning/sources/youtube", {
                            url: videoLink.trim(),
                            ...(title.trim() ? { title: title.trim() } : {}),
                            ...f,
                          }).catch((err: unknown) => {
                            // YouTube refuses some servers. Pasting the transcript under Notes still works.
                            if (err instanceof ApiError && err.code === "YOUTUBE_BLOCKED") setMode("text");
                            throw err;
                          })
                        : await api.post<LearningDocument>("/v1/learning/sources/text", { title: title.trim(), text: notes, ...f });
                  added(doc);
                }, "Got it. Check anything highlighted before making flashcards, a quiz or a cheatsheet.")
              }
            >
              {busy ? "Reading…" : mode === "youtube" ? "Get the video's captions" : "Add and read"}
            </button>
            <p className="text-xs text-muted">
              {mode === "youtube"
                ? "TutorPAL uses the video's captions. Videos without captions cannot be used; paste notes instead."
                : "A PDF or photo up to 10 MB, or pasted notes. It stays private to your family."}
            </p>
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
                <span className="shrink-0 text-sm text-muted">{s.status === "failed" ? "Could not read" : KIND_LABEL[s.kind]}</span>
              </button>
            ))}
          </section>

          {decks.length > 0 ? (
            <section className={card}>
              <h2 className="text-sm font-medium">Flashcards</h2>
              {decks.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void act(async () => openDeck(await api.get<Deck>(`/v1/learning/decks/${d.id}`)))}
                  className={`flex w-full justify-between gap-3 text-left ${row}`}
                >
                  <span className="min-w-0 truncate font-medium">{d.title}</span>
                  <span className={`shrink-0 text-sm ${d.dueCount > 0 ? "text-tutor" : "text-muted"}`}>
                    {d.dueCount > 0 ? `${d.dueCount} due` : `${d.cardCount} cards`}
                  </span>
                </button>
              ))}
            </section>
          ) : null}

          {sheets.length > 0 ? (
            <section className={card}>
              <h2 className="text-sm font-medium">Cheatsheets</h2>
              {sheets.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void act(async () => setView({ kind: "cheatsheet", sheet: await api.get<Cheatsheet>(`/v1/learning/cheatsheets/${s.id}`) }))}
                  className={`w-full truncate text-left font-medium ${row}`}
                >
                  {s.title}
                </button>
              ))}
            </section>
          ) : null}

          {interviews.length > 0 ? (
            <section className={card}>
              <h2 className="text-sm font-medium">Interviews</h2>
              {interviews.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void act(async () => setView({ kind: "interview", interview: await api.get<Interview>(`/v1/learning/interviews/${i.id}`) }))}
                  className={`flex w-full justify-between gap-3 text-left ${row}`}
                >
                  <span className="min-w-0 truncate font-medium">{i.title}</span>
                  <span className="shrink-0 text-sm text-muted">{i.status === "complete" ? `${i.score}/${i.asked}` : "Carry on"}</span>
                </button>
              ))}
            </section>
          ) : null}

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

          {profile ? <Timetable profile={profile} onChange={setProfile} childName={parent ? nameOf(target) : ""} /> : null}
        </>
      ) : null}

      {view.kind === "document" ? (
        <>
          <section className={card}>
            <h2 className="text-lg font-semibold">{view.doc.title}</h2>
            <p className="text-xs text-muted">
              {METHOD_LABEL[view.doc.method] ?? ""}
              {view.doc.sourceUrl ? (
                <>
                  {" "}
                  <a href={view.doc.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    Watch it
                  </a>
                </>
              ) : null}
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
                  openDeck(await api.post<Deck>(`/v1/learning/documents/${view.doc.id}/flashcards`, { count: 10 }));
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
              5-question quiz
            </button>
            <button
              type="button"
              disabled={busy || view.doc.needsReview > 0}
              className={secondary}
              onClick={() =>
                void act(async () => {
                  setView({ kind: "cheatsheet", sheet: await api.post<Cheatsheet>(`/v1/learning/documents/${view.doc.id}/cheatsheets`) });
                })
              }
            >
              Cheatsheet
            </button>
            {me?.memberId === view.doc.ownerMemberId ? (
              <button
                type="button"
                disabled={busy || view.doc.needsReview > 0}
                className={secondary}
                onClick={() =>
                  void act(async () => {
                    setView({
                      kind: "interview",
                      interview: await api.post<Interview>(`/v1/learning/documents/${view.doc.id}/interviews`, { count: 5 }),
                    });
                  })
                }
              >
                Practice interview
              </button>
            ) : null}
          </section>
          {parent ? (
            <p className="text-xs text-muted">
              Interviews, quizzes and reviews count towards {nameOf(view.doc.ownerMemberId) || "the child"}'s own progress, so only they can take them.
            </p>
          ) : null}
        </>
      ) : null}

      {view.kind === "deck" ? (
        <>
          <DeckReview key={view.deck.id} deck={view.deck} canGrade={me?.memberId === view.deck.ownerMemberId} onError={setError} />
          <p className="text-xs text-muted">Saved on this device, so it works offline too.</p>
        </>
      ) : null}

      {view.kind === "cheatsheet" ? <CheatsheetView sheet={view.sheet} /> : null}

      {view.kind === "interview" ? (
        <InterviewView key={view.interview.id} initial={view.interview} canAnswer={me?.memberId === view.interview.memberId} />
      ) : null}

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
                                results: result!.results.map((r) => (r.questionId === q.id ? { ...r, correctAnswer: revealed.answer } : r)),
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
