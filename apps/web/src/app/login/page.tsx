"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ApiError, api, markSignedIn, type Me } from "@/lib/api";

type Stage = "start" | "code";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(options: { client_id: string; callback: (response: { credential: string }) => void }): void;
          renderButton(element: HTMLElement, options: Record<string, unknown>): void;
        };
      };
    };
  }
}

/** Google's own button. Renders nothing until a client id is configured. */
function GoogleButton({ onCredential }: { onCredential: (credential: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const handler = useRef(onCredential);
  handler.current = onCredential;

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    const render = () => {
      if (!window.google || !container.current) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => handler.current(response.credential),
      });
      window.google.accounts.id.renderButton(container.current, {
        theme: "outline",
        size: "large",
        shape: "pill",
        text: "continue_with",
        width: 320,
      });
    };
    if (window.google) {
      render();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }, []);

  if (!GOOGLE_CLIENT_ID) return null;
  return <div ref={container} className="flex min-h-11 justify-center" />;
}

/**
 * Parent sign-in is a magic-link code sent to email — proving the inbox is
 * the authentication event, no password to manage or leak. A child never
 * goes through this: they have no email, so joining mints the device its own
 * session first (POST /v1/auth/device) and then redeems the code against it.
 */
export default function Login() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("start");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function afterSignIn() {
    markSignedIn();
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
  }

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/auth/request-code", { email: email.trim() });
      setStage("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/auth/verify", { email: email.trim(), code: otp.trim() });
      await afterSignIn();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "INVALID_CODE"
            ? "That code is wrong or has expired."
            : err.message
          : "Something went wrong.",
      );
      setBusy(false);
    }
  }

  async function googleSignIn(credential: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/auth/google", { credential });
      await afterSignIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Google sign-in did not work.");
      setBusy(false);
    }
  }

  async function joinWithCode() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/auth/device");
      await api.post("/v1/join", { code: code.trim().toUpperCase() });
      await afterSignIn();
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
        <p className="text-muted">One app where your PALs work together.</p>
      </header>

      <section className="space-y-4 rounded-2xl bg-card p-6 shadow-sm">
        {stage === "start" ? (
          <>
            {GOOGLE_CLIENT_ID ? (
              <>
                <GoogleButton onCredential={(credential) => void googleSignIn(credential)} />
                <p className="text-center text-xs text-muted">or use your email</p>
              </>
            ) : null}
            <label className="block space-y-2">
              <span className="text-sm font-medium">Your email</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                type="email"
                autoComplete="email"
                className="w-full rounded-xl border border-line bg-ground px-4 py-3 outline-none focus:border-accent"
              />
            </label>
            <button
              type="button"
              onClick={() => void sendCode()}
              disabled={busy || !email.includes("@")}
              className="w-full rounded-xl bg-accent px-4 py-3 font-medium text-white disabled:opacity-50"
            >
              {busy ? "One moment…" : "Send me a code"}
            </button>
          </>
        ) : (
          <>
            <label className="block space-y-2">
              <span className="text-sm text-muted">
                Enter the 6-digit code sent to {email}
              </span>
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                className="w-full rounded-xl border border-line bg-ground px-4 py-3 font-mono tracking-[0.3em] outline-none focus:border-accent"
              />
            </label>
            <button
              type="button"
              onClick={() => void verifyCode()}
              disabled={busy || otp.length !== 6}
              className="w-full rounded-xl bg-accent px-4 py-3 font-medium text-white disabled:opacity-50"
            >
              {busy ? "One moment…" : "Sign in"}
            </button>
            <button
              type="button"
              onClick={() => setStage("start")}
              className="w-full text-sm text-muted underline underline-offset-4"
            >
              Use a different email
            </button>
          </>
        )}
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
          onClick={() => void joinWithCode()}
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
