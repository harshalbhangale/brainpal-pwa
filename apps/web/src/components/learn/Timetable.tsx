"use client";

import { useState } from "react";

import { ApiError, api, type StudentProfile } from "@/lib/api";

const card = "space-y-3 rounded-2xl bg-card p-5 shadow-sm";
const row = "rounded-xl bg-ground px-4 py-3";
const input = "w-full min-w-0 rounded-xl border border-line bg-ground px-3 py-2 outline-none focus:border-accent";
const primary = "shrink-0 rounded-xl bg-tutor px-4 py-2 font-medium text-white disabled:opacity-40";
const link = "text-xs text-muted underline underline-offset-4 disabled:opacity-40";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** School weeks start on Monday. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function daysUntil(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((new Date(y!, m! - 1, d!).getTime() - start) / 86_400_000);
}

export function Timetable({
  profile,
  onChange,
  childName,
}: {
  profile: StudentProfile;
  onChange: (next: StudentProfile) => void;
  childName: string;
}) {
  const [name, setName] = useState("");
  const [exam, setExam] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [weekday, setWeekday] = useState(1);
  const [startsAt, setStartsAt] = useState("09:00");
  const [endsAt, setEndsAt] = useState("09:50");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<StudentProfile>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const nameOf = new Map(profile.subjects.map((s) => [s.id, s.name]));
  const classes = profile.subjects.flatMap((s) => s.classes);
  const exams = profile.subjects
    .filter((s) => s.nextExamDate && daysUntil(s.nextExamDate) >= 0)
    .sort((a, b) => a.nextExamDate!.localeCompare(b.nextExamDate!));
  const chosen = subjectId || profile.subjects[0]?.id || "";

  return (
    <section className={card}>
      <h2 className="text-sm font-medium">{childName ? `${childName}'s` : "My"} subjects and timetable</h2>

      {exams.length > 0 ? (
        <div className="space-y-1">
          {exams.map((s) => {
            const days = daysUntil(s.nextExamDate!);
            return (
              <p key={s.id} className="text-sm">
                <span className="font-medium">{s.name}</span> exam{" "}
                <span className="text-tutor">{days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}</span>
              </p>
            );
          })}
        </div>
      ) : null}

      {classes.length > 0 ? (
        <div className="space-y-2">
          {WEEK.filter((d) => classes.some((c) => c.weekday === d)).map((d) => (
            <div key={d} className={row}>
              <p className="text-xs font-medium text-muted">{DAYS[d]}</p>
              {classes
                .filter((c) => c.weekday === d)
                .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
                .map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                    <span>
                      {c.startsAt}–{c.endsAt} · <span className="font-medium">{nameOf.get(c.subjectId)}</span>
                      {c.location ? <span className="text-muted"> · {c.location}</span> : null}
                    </span>
                    <button type="button" disabled={busy} className={link} onClick={() => void act(() => api.del(`/v1/learning/classes/${c.id}`))}>
                      Remove
                    </button>
                  </div>
                ))}
            </div>
          ))}
        </div>
      ) : null}

      {profile.subjects.map((s) => (
        <div key={s.id} className={`flex flex-wrap items-center justify-between gap-2 ${row}`}>
          <span className="font-medium">{s.name}</span>
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted" htmlFor={`exam-${s.id}`}>
              Exam
            </label>
            <input
              id={`exam-${s.id}`}
              type="date"
              defaultValue={s.nextExamDate ?? ""}
              disabled={busy}
              onBlur={(e) => {
                const value = e.target.value || null;
                if (value !== s.nextExamDate) void act(() => api.post(`/v1/learning/subjects/${s.id}`, { nextExamDate: value }));
              }}
              className="rounded-lg border border-line bg-card px-2 py-1 text-sm"
            />
            <button
              type="button"
              disabled={busy}
              className={link}
              onClick={() => {
                if (window.confirm(`Remove ${s.name} and its classes? Material filed under it is kept.`)) {
                  void act(() => api.del(`/v1/learning/subjects/${s.id}`));
                }
              }}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a subject, e.g. Maths" className={input} />
        <input type="date" value={exam} onChange={(e) => setExam(e.target.value)} aria-label="Next exam (optional)" className="w-36 shrink-0 rounded-xl border border-line bg-ground px-2 text-sm" />
        <button
          type="button"
          disabled={busy || !name.trim()}
          className={primary}
          onClick={() =>
            void act(async () => {
              const next = await api.post<StudentProfile>(`/v1/learning/profiles/${profile.memberId}/subjects`, {
                name: name.trim(),
                ...(exam ? { nextExamDate: exam } : {}),
              });
              setName("");
              setExam("");
              return next;
            })
          }
        >
          Add
        </button>
      </div>

      {profile.subjects.length > 0 ? (
        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-xs text-muted">Add a weekly class</p>
          <div className="grid grid-cols-2 gap-2">
            <select value={chosen} onChange={(e) => setSubjectId(e.target.value)} aria-label="Subject" className={input}>
              {profile.subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} aria-label="Day" className={input}>
              {WEEK.map((d) => (
                <option key={d} value={d}>
                  {DAYS[d]}
                </option>
              ))}
            </select>
            <input type="time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} aria-label="Starts" className={input} />
            <input type="time" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} aria-label="Ends" className={input} />
          </div>
          <div className="flex gap-2">
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Room (optional)" className={input} />
            <button
              type="button"
              disabled={busy || !chosen}
              className={primary}
              onClick={() =>
                void act(() =>
                  api.post<StudentProfile>(`/v1/learning/subjects/${chosen}/classes`, {
                    weekday,
                    startsAt,
                    endsAt,
                    ...(location.trim() ? { location: location.trim() } : {}),
                  }),
                )
              }
            >
              Add class
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-accent">
          {error}
        </p>
      ) : null}
    </section>
  );
}
