"use client";

import { useEffect, useRef, useState } from "react";

import { ApiError, api, transcribeAudio, type Interview, type InterviewTurn, type NextStep } from "@/lib/api";

const card = "space-y-3 rounded-2xl bg-card p-5 shadow-sm";
const input = "w-full min-w-0 rounded-xl border border-line bg-ground px-3 py-2 outline-none focus:border-accent";
const primary = "shrink-0 rounded-xl bg-tutor px-4 py-2 font-medium text-white disabled:opacity-40";
const secondary = "shrink-0 rounded-xl border border-line px-4 py-2 font-medium disabled:opacity-40";

const MAX_RECORDING_MS = 60_000;

const NEXT_LABEL: Record<string, string> = {
  review_flashcards: "Review with flashcards",
  retry_quiz: "Try the quiz again",
  harder_quiz: "Try a harder quiz",
};

/** Read aloud with the device's own voice: nothing is sent anywhere to do it. */
function speak(text: string, interrupt: boolean) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  if (interrupt) window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-AU";
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}

/**
 * TutorPAL asks, the child answers by typing or out loud. A spoken answer is
 * turned into text the child can check and edit before sending, so a
 * mishearing is caught before it is marked.
 */
export function InterviewView({ initial, canAnswer }: { initial: Interview; canAnswer: boolean }) {
  const [interview, setInterview] = useState<Interview>(initial);
  const [text, setText] = useState("");
  const [reply, setReply] = useState<InterviewTurn["reply"] | null>(null);
  const [finish, setFinish] = useState<{ nextStep: NextStep; mastery: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [readAloud, setReadAloud] = useState(true);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const current = interview.questions.find((q) => q.id === interview.currentQuestionId) ?? null;
  const number = current ? interview.questions.indexOf(current) + 1 : interview.questions.length;

  useEffect(() => {
    if (current && readAloud && canAnswer) speak(current.prompt, false);
    // Only when the question changes: re-reading on every render would talk over the child.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  useEffect(
    () => () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
      if (recorder.current?.state === "recording") recorder.current.stop();
      window.clearTimeout(timer.current);
    },
    [],
  );

  async function startRecording() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser cannot record. Type your answer instead.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Allow the microphone to answer out loud, or type your answer instead.");
      return;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    const type = ["audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      window.clearTimeout(timer.current);
      setRecording(false);
      const recordingBlob = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" });
      if (recordingBlob.size === 0) return;
      void (async () => {
        setBusy(true);
        try {
          const heard = await transcribeAudio(recordingBlob);
          setText((t) => (t.trim() ? `${t.trim()} ${heard}` : heard));
        } catch (err) {
          setError(err instanceof ApiError ? err.message : "Could not hear that. Try again, or type your answer.");
        } finally {
          setBusy(false);
        }
      })();
    };
    recorder.current = rec;
    rec.start();
    setRecording(true);
    timer.current = window.setTimeout(() => {
      if (rec.state === "recording") rec.stop();
    }, MAX_RECORDING_MS);
  }

  async function send() {
    const answer = text.trim();
    if (!answer || busy) return;
    setBusy(true);
    setError(null);
    try {
      const turn = await api.post<InterviewTurn>(`/v1/learning/interviews/${interview.id}/answers`, { text: answer });
      setInterview(turn);
      setReply(turn.reply ?? null);
      setText("");
      if (turn.nextStep) setFinish({ nextStep: turn.nextStep, mastery: turn.mastery ?? null });
      if (readAloud && turn.reply) speak(turn.reply.feedback, true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not send. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function reveal(questionId: string) {
    setBusy(true);
    try {
      const { answer } = await api.post<{ answer: string }>(`/v1/learning/interviews/${interview.id}/reveal`, { questionId });
      setInterview({ ...interview, questions: interview.questions.map((q) => (q.id === questionId ? { ...q, answer } : q)) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const past = interview.questions.filter((q) => q.done);

  return (
    <>
      <section className={card}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{interview.title}</h2>
            <p className="text-xs text-muted">
              {interview.status === "complete"
                ? `Finished · ${interview.score} of ${interview.questions.length} right`
                : `Question ${number} of up to ${interview.questionCount}`}
            </p>
          </div>
          {canAnswer && interview.status === "active" ? (
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
              Read aloud
            </label>
          ) : null}
        </div>

        {reply ? (
          <p className={`rounded-xl bg-ground px-4 py-3 text-sm ${reply.correct ? "text-tutor" : "text-accent"}`}>
            {reply.correct ? "Right! " : reply.tryAgain ? "Not quite. " : "Not this time. "}
            {reply.feedback}
            {reply.needsReview ? " (A parent may want to check this mark.)" : ""}
          </p>
        ) : null}

        {current ? (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-lg font-semibold">{current.prompt}</p>
              <button
                type="button"
                aria-label="Read the question aloud"
                onClick={() => speak(current.prompt, true)}
                className="shrink-0 text-sm text-muted underline underline-offset-4"
              >
                Hear it
              </button>
            </div>
            {current.replies.map((r, i) => (
              <p key={i} className="text-sm text-muted">
                You said: “{r.text}”
              </p>
            ))}
            {canAnswer ? (
              <>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  placeholder={recording ? "Listening…" : "Type your answer, or tap Speak"}
                  aria-label="Your answer"
                  className={input}
                />
                <div className="flex flex-wrap gap-2">
                  {recording ? (
                    <button type="button" className={`${secondary} border-accent text-accent`} onClick={() => recorder.current?.stop()}>
                      ■ Stop
                    </button>
                  ) : (
                    <button type="button" disabled={busy} className={secondary} onClick={() => void startRecording()}>
                      🎤 Speak
                    </button>
                  )}
                  <button type="button" disabled={busy || recording || !text.trim()} className={primary} onClick={() => void send()}>
                    {busy ? "Thinking…" : "Send answer"}
                  </button>
                </div>
                <p className="text-xs text-muted">Your recording is turned into text for you to check. BrainPal does not keep it.</p>
              </>
            ) : (
              <p className="text-sm text-muted">Only the child can answer this interview.</p>
            )}
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-accent">
            {error}
          </p>
        ) : null}
      </section>

      {finish ? (
        <section className={card}>
          <p className="text-lg font-semibold">
            {interview.score} out of {interview.questions.length}
          </p>
          <p className="text-sm">
            Next: {NEXT_LABEL[finish.nextStep.activity]} — {finish.nextStep.reason}
          </p>
        </section>
      ) : null}

      {past.length > 0 ? (
        <section className={card}>
          <h3 className="text-sm font-medium">So far</h3>
          {past.map((q) => {
            const right = q.replies.some((r) => r.correct);
            return (
              <div key={q.id} className="space-y-1 rounded-xl bg-ground px-4 py-3">
                <p className="font-medium">{q.prompt}</p>
                {q.replies.map((r, i) => (
                  <p key={i} className="text-sm">
                    <span className={r.correct ? "text-tutor" : "text-accent"}>{r.correct ? "✓" : "✗"}</span> {r.text}
                    <span className="block text-xs text-muted">{r.feedback}</span>
                  </p>
                ))}
                {q.answer && !right ? <p className="text-sm text-muted">Answer: {q.answer}</p> : null}
                {!q.answer && !right ? (
                  <button type="button" disabled={busy} className="text-sm underline underline-offset-4" onClick={() => void reveal(q.id)}>
                    Show me the answer
                  </button>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}
    </>
  );
}
