import { createHash } from "node:crypto";

import { MoneyError } from "./errors.js";

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MoneyError("INVALID_NUMBER", "command numbers must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  throw new MoneyError("INVALID_PAYLOAD", "payload contains an unsupported value");
}

/** Key order never changes the output, so equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
