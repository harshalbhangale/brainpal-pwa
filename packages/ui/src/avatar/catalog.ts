import type { AvatarStyle } from "@brainpal/contracts";

/**
 * The approved catalog. Deliberately a short, fixed list rather than an open
 * generator: a child picks from characters an adult has already vetted.
 *
 * Assets are addressed by id and version, never by URL, so the art can be
 * redrawn or moved to a CDN without touching a single stored member row.
 */
export const ASSET_VERSION = 1;

export interface MascotEntry {
  id: string;
  /** What a child sees in the picker. */
  name: string;
  /** Used for the screen-reader label and the initials fallback tint. */
  tint: string;
}

export const MASCOTS: readonly MascotEntry[] = [
  { id: "fox", name: "Fox", tint: "#E2703A" },
  { id: "owl", name: "Owl", tint: "#7C6A9C" },
  { id: "cat", name: "Cat", tint: "#4E8FA8" },
  { id: "bear", name: "Bear", tint: "#8A6242" },
  { id: "frog", name: "Frog", tint: "#5B9A54" },
  { id: "panda", name: "Panda", tint: "#5A5A66" },
];

/** Styles with art in this asset version. The contract allows more. */
export const AVAILABLE_STYLES: readonly AvatarStyle[] = ["colour"];

const BY_ID = new Map(MASCOTS.map((m) => [m.id, m]));

export function findMascot(id: string | null | undefined): MascotEntry | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function isApproved(id: string | null | undefined): boolean {
  return Boolean(id && BY_ID.has(id));
}

export interface SheetPaths {
  directions: string;
  reactions: string;
}

/**
 * Where a character's two sprite sheets live. Version sits in the path so a new
 * generation of art can be served alongside the old one while members migrate.
 */
export function sheetsFor(
  mascotId: string,
  style: AvatarStyle,
  version: number = ASSET_VERSION,
  base = "/mascots",
): SheetPaths {
  const prefix = `${base}/v${version}/${style}/${mascotId}`;
  return {
    directions: `${prefix}.directions.svg`,
    reactions: `${prefix}.reactions.svg`,
  };
}
