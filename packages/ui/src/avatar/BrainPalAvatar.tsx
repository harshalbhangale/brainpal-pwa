import type { AvatarState, AvatarStyle } from "@brainpal/contracts";

import { ASSET_VERSION, findMascot, sheetsFor } from "./catalog.js";
import { Mascot } from "./mascot.js";

export type AvatarSize = "small" | "medium" | "large";

const PIXELS: Record<AvatarSize, number> = {
  small: 40,
  medium: 88,
  large: 160,
};

export interface BrainPalAvatarProps {
  /** Approved catalog id. Anything unknown falls back to initials. */
  mascotId?: string | null;
  style?: AvatarStyle | null;
  version?: number | null;
  /** Name the avatar stands for. Used for the label and the fallback initial. */
  name: string;
  state?: AvatarState;
  size?: AvatarSize;
  /** False for decoration that should not be tabbable. */
  interactive?: boolean;
  className?: string;
}

/**
 * The only place in the product that knows a mascot library exists.
 *
 * Everything the avatar doc asks the wrapper to own lives here: catalog
 * lookup, fallback, PAL state mapping, accessible labelling and asset
 * versioning. Replacing or extending the renderer touches this file and its
 * sibling, and nothing else.
 */
export function BrainPalAvatar({
  mascotId,
  style,
  version,
  name,
  state = "idle",
  size = "medium",
  interactive = false,
  className,
}: BrainPalAvatarProps) {
  const pixels = PIXELS[size];
  const entry = findMascot(mascotId);

  // An unapproved id, a style with no art, or a member who has not chosen yet
  // all land on initials rather than a broken image.
  if (!entry || !style) {
    return (
      <Initials name={name} pixels={pixels} className={className} />
    );
  }

  const sheets = sheetsFor(entry.id, style, version ?? ASSET_VERSION);

  return (
    <Mascot
      directions={sheets.directions}
      reactions={sheets.reactions}
      state={state}
      size={pixels}
      label={labelFor(name, entry.name, state)}
      interactive={interactive}
      {...(className ? { className } : {})}
    />
  );
}

function labelFor(name: string, mascot: string, state: AvatarState): string {
  const doing =
    state === "thinking"
      ? ", thinking"
      : state === "speaking"
        ? ", speaking"
        : state === "success"
          ? ", pleased"
          : state === "error"
            ? ", concerned"
            : "";
  return `${name}'s ${mascot.toLowerCase()} avatar${doing}`;
}

/** Stable per name, so the same person keeps the same colour everywhere. */
const FALLBACK_TINTS = [
  "#E2703A",
  "#7C6A9C",
  "#4E8FA8",
  "#8A6242",
  "#5B9A54",
  "#5A5A66",
];

function Initials({
  name,
  pixels,
  className,
}: {
  name: string;
  pixels: number;
  className?: string | undefined;
}) {
  const trimmed = name.trim();
  const initial = trimmed ? [...trimmed][0]!.toUpperCase() : "?";

  let hash = 0;
  for (const char of trimmed) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  const tint = FALLBACK_TINTS[Math.abs(hash) % FALLBACK_TINTS.length]!;

  return (
    <span
      className={className}
      role="img"
      aria-label={`${trimmed || "Someone"}'s avatar`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        width: pixels,
        height: pixels,
        borderRadius: "50%",
        background: tint,
        color: "#fff",
        fontSize: Math.round(pixels * 0.42),
        fontWeight: 600,
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      {initial}
    </span>
  );
}
