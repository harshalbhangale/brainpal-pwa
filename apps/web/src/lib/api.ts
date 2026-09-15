"use client";

const BASE =
  process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

const TOKEN_KEY = "brainpal.token";
const NAME_KEY = "brainpal.name";

/**
 * The name typed at sign-in, held until onboarding can attach it to a member.
 * Convenience only — the server never trusts it, and losing it costs a retype.
 */
export function getPendingName(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setPendingName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    /* the user retypes it; nothing breaks */
  }
}

/**
 * The session now lives in an httpOnly cookie the browser attaches on its
 * own — this module never reads or writes the token itself. `hasSignedIn`
 * is a plain localStorage flag purely so the UI can skip straight to a
 * loading state instead of flashing the login screen before the first API
 * call confirms whether the cookie is still valid.
 */
const SIGNED_IN_KEY = "brainpal.signedIn";

export function hasSignedIn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIGNED_IN_KEY) === "true";
  } catch {
    return false;
  }
}

export function markSignedIn(): void {
  try {
    window.localStorage.setItem(SIGNED_IN_KEY, "true");
  } catch {
    /* private browsing; the flag simply will not persist */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    /* nothing to do */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
  } catch {
    // Offline, or the API is down. Rule 9: say so plainly.
    throw new ApiError(0, "OFFLINE", "Cannot reach BrainPal right now.");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? "UNKNOWN",
      body?.error?.message ?? response.statusText,
    );
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
};

export interface Me {
  memberId: string;
  familyId: string;
  role: "parent" | "co_guardian" | "child";
  displayName: string;
}

export interface Member {
  id: string;
  role: string;
  status: string;
  displayName: string;
  avatarMascotId: string | null;
  avatarStyle: string | null;
  avatarVersion: number | null;
}

export interface Family {
  id: string;
  name: string;
  currency: string;
  members: Member[];
}

export interface Pal {
  id: "brainpal" | "moneypal" | "tutorpal";
  name: string;
  description: string;
  active: boolean;
  level: number;
}

export interface ThreadSummary {
  id: string;
  title: string;
  ownerPal: string;
  subjectMemberId: string | null;
  updatedAt: string;
}

export interface Wallet {
  familyWalletMinor?: number;
  children: Array<{ memberId: string; displayName: string; spendMinor: number; saveMinor: number }>;
}

export interface Chore {
  id: string;
  assignedMemberId: string;
  title: string;
  detail: string | null;
  rewardMinor: number;
  destination: "spend" | "save";
  status: "open" | "submitted" | "redo" | "paid" | "cancelled";
  redoNote: string | null;
}

export interface Approval {
  id: string;
  kind: string;
  display: { title: string; detail: string; confirmLabel: string; cancelLabel: string } | null;
  expiresAt: string;
}

export interface CommandOutcome {
  commandId: string;
  status: string;
  replayed: boolean;
  result: Record<string, unknown> | null;
}

/**
 * One key per user action. The button is disabled while the request is in
 * flight, so a double-tap cannot send a second key; a network retry of the
 * same fetch would replay rather than run twice.
 */
export function moneyCommand(command: string, payload: unknown): Promise<CommandOutcome> {
  return request<CommandOutcome>("/v1/money/commands", {
    method: "POST",
    body: JSON.stringify({ command, payload }),
    headers: { "idempotency-key": crypto.randomUUID() },
  });
}

/** Server-sent events from POST /v1/agent/turn. */
export type TurnEvent =
  | { type: "routed"; ownerPal: string; intent: string; confidence: number; threadId?: string }
  | { type: "delta"; text: string; threadId?: string }
  | { type: "done"; result: { ownerPal: string; message: string }; threadId?: string }
  | { type: "error"; code: string; message: string; threadId?: string };

/**
 * The turn is a POST that streams, so EventSource is not an option — it cannot
 * send a body or an Authorization header. This reads the response body itself.
 */
export async function* streamTurn(
  text: string,
  threadId?: string,
): AsyncGenerator<TurnEvent> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/v1/agent/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(threadId ? { text, threadId } : { text }),
    });
  } catch {
    // Offline, blocked or refused. Unguarded, this rejection propagates out of
    // the generator and leaves the composer spinning with no message at all.
    yield {
      type: "error",
      code: "OFFLINE",
      message: "Cannot reach BrainPal right now.",
    };
    return;
  }

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    yield {
      type: "error",
      code: body?.error?.code ?? "UNKNOWN",
      message: body?.error?.message ?? "The turn failed.",
    };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; a partial one stays in the buffer.
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith("data: ")) {
        try {
          yield JSON.parse(frame.slice(6)) as TurnEvent;
        } catch {
          /* a truncated frame is not worth failing the whole turn over */
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
