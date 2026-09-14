"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiError, api, setPendingName, setToken, type Me } from "@/lib/api";

/**
 * Phase 1 sign-in. Deliberately a mock: it mints a `mock:<subject>` token so
 * the agent loop could be built before Cognito. The API refuses these outside
 * development, and this whole screen is replaced — not extended — when real
 * sign-in lands.
 */
export default function Login() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(joinCode?: string) {
    setBusy(true);
    setError(null);

    // Everything lives inside the try, including the token writes. Anything
    // that throws out here would leave the button reading "One moment…"
    // forever, with no error and no way back.
    try {
      const trimmed = name.trim();
      const subject = `${trimmed.toLowerCase().replace(/\s+/g, "-") || "user"}-${crypto.randomUUID().slice(0, 8)}`;
      setToken(`mock:${subject}`);
      setPendingName(trimmed);

      if (joinCode) {
        await api.post("/v1/join", { code: joinCode.trim().toUpperCase() });
        router.push("/home");
        return;
      }

      // An existing membership goes straight home; a new one onboards.
      try {
        await api.get<Me>("/v1/me");
        router.push("/home");
      } catch (err) {
        if (err instanceof ApiError && err.code === "NO_MEMBERSHIP") {
          router.push("/onboarding");
          return;
        }
        throw err;
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "INVALID_CODE"
            ? "That code does not work. Ask a parent for a new one."
            : err.message
          : "Something went wrong.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">BrainPal</h1>
        <p className="text-muted">
          One app where your PALs work together.
        </p>
      </header>

      <section className="space-y-4 rounded-2xl bg-card p-6 shadow-sm">
        <label className="block space-y-2">
          <span className="text-sm font-medium">Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Harshal"
            autoComplete="given-name"
            className="w-full rounded-xl border border-line bg-ground px-4 py-3 outline-none focus:border-accent"
          />
        </label>

        <button
          type="button"
          onClick={() => void signIn()}
          disabled={busy}
          className="w-full rounded-xl bg-accent px-4 py-3 font-medium text-white disabled:opacity-50"
        >
          {busy ? "One moment…" : "Start as a parent"}
        </button>
      </section>

      <section className="space-y-4 rounded-2xl bg-card p-6 shadow-sm">
        <h2 className="text-sm font-medium">Joining your family?</h2>
        <label className="block space-y-2">
          <span className="text-sm text-muted">Enter your join code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
            inputMode="text"
            autoCapitalize="characters"
            maxLength={8}
            className="w-full rounded-xl border border-line bg-ground px-4 py-3 font-mono tracking-[0.3em] outline-none focus:border-accent"
          />
        </label>
        <button
          type="button"
          onClick={() => void signIn(code)}
          disabled={busy || code.trim().length < 4}
          className="w-full rounded-xl border border-line px-4 py-3 font-medium disabled:opacity-40"
        >
          Join my family
        </button>
      </section>

      {error ? (
        <p role="alert" className="rounded-xl bg-card px-4 py-3 text-sm text-accent">
          {error}
        </p>
      ) : null}
    </main>
  );
}
