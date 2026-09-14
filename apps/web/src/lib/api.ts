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
 * Phase 1 keeps the mock token in localStorage. That is fine for a mock and
 * wrong for a real one: when Cognito lands the token moves to an httpOnly
 * cookie and this module is the only thing that changes.
 */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private browsing; the session simply will not persist */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
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
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, headers });
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
  const token = getToken();
  const response = await fetch(`${BASE}/v1/agent/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(threadId ? { text, threadId } : { text }),
  });

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
