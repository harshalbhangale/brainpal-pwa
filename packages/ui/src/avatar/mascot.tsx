/*
 * Vendored from page-mascot v0.1.0 — https://github.com/nilbuild/page-mascot
 *
 * MIT License. Copyright (c) 2026 Kamran Ahmed <https://kamran.fyi>
 * The full licence text is kept alongside this file in LICENSE.page-mascot.
 *
 * Why vendored rather than depended on: the published component holds all of
 * its state internally — direction follows the pointer, reaction comes from a
 * click — and exposes no way to drive either from outside. BrainPal needs the
 * mascot to react to what a PAL is doing (thinking, speaking, succeeding,
 * failing), which is a prop the package does not have and cannot be given from
 * the outside. It is 168 lines and the upstream build script copies this source
 * as a matter of course.
 *
 * Changes from upstream:
 *   - added the `state` prop, which drives the reaction cell and the animation
 *   - added an idle blink, so a mascot is alive on a touch screen where there
 *     is no pointer to follow
 *   - reduced motion suppresses movement, never information
 */
import { type CSSProperties, useEffect, useRef, useState } from "react";

const DIRECTIONS = [
  "up-left",
  "up",
  "up-right",
  "left",
  "center",
  "right",
  "down-left",
  "down",
  "down-right",
] as const;

const REACTIONS = [
  "blink",
  "heart",
  "sparkle",
  "surprised",
  "wink",
  "bashful",
  "sleepy",
  "dizzy",
  "delighted",
] as const;

type Direction = (typeof DIRECTIONS)[number];
type Reaction = (typeof REACTIONS)[number];

export type MascotState =
  | "idle"
  | "thinking"
  | "speaking"
  | "success"
  | "error";

/** Clockwise from the right, matching atan2 with y pointing down. */
const CLOCKWISE: Direction[] = [
  "right",
  "down-right",
  "down",
  "down-left",
  "left",
  "up-left",
  "up",
  "up-right",
];

const SECTOR = (Math.PI * 2) / CLOCKWISE.length;
const HYSTERESIS = 0.12;
const DEAD_ZONE = 70;
const PAYOFFS: Reaction[] = ["heart", "sparkle", "delighted"];
const BOOP_PAYOFF = 120;
const BOOP_END = 560;
const SQUASH_MS = 420;
const DIZZY_AFTER = 4;
const DIZZY_WINDOW = 1600;
const DIZZY_END = 1100;

const BLINK_MIN_MS = 3200;
const BLINK_MAX_MS = 7200;
const BLINK_MS = 140;

const SQUASH: Keyframe[] = [
  { transform: "scale(1, 1)", easing: "ease-in" },
  { transform: "scale(1.10, 0.86)", offset: 0.18, easing: "ease-out" },
  { transform: "scale(0.95, 1.08)", offset: 0.45, easing: "ease-in-out" },
  { transform: "scale(1.03, 0.97)", offset: 0.72, easing: "ease-in-out" },
  { transform: "scale(1, 1)" },
];

/** The face a PAL wears while it is doing something. */
const STATE_REACTION: Record<MascotState, Reaction | null> = {
  idle: null,
  thinking: null,
  speaking: null,
  success: "delighted",
  error: "surprised",
};

/** background-size 300% makes each cell a clean 0/50/100% step on both axes. */
function cell(index: number): CSSProperties {
  return {
    backgroundPosition: `${(index % 3) * 50}% ${Math.floor(index / 3) * 50}%`,
  };
}

function wrap(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const layer: CSSProperties = {
  position: "absolute",
  inset: 0,
  backgroundSize: "300% 300%",
  backgroundRepeat: "no-repeat",
};

export type MascotProps = {
  /** The 3x3 sheet of head directions. A served path, or an imported image. */
  directions: string;
  /** The 3x3 sheet of expressions. */
  reactions: string;
  /** What the mascot is doing. Drives both expression and movement. */
  state?: MascotState;
  size?: number;
  className?: string;
  /** What a screen reader calls it. */
  label?: string;
  /** Set false for a decorative mascot that should not be tabbable. */
  interactive?: boolean;
};

export function Mascot(props: MascotProps) {
  const {
    directions,
    reactions,
    state = "idle",
    size = 140,
    className,
    label = "mascot",
    interactive = true,
  } = props;

  const rootRef = useRef<HTMLElement | null>(null);
  const squashRef = useRef<HTMLSpanElement | null>(null);
  const timersRef = useRef<number[]>([]);
  const boopsRef = useRef({ count: 0, at: 0 });

  const [direction, setDirection] = useState<Direction>("center");
  const [booped, setBooped] = useState<Reaction | null>(null);
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      return;
    }

    let sector = -1;
    let pointer: { x: number; y: number } | null = null;

    const aim = () => {
      const root = rootRef.current;
      if (!root || !pointer) return;

      const box = root.getBoundingClientRect();
      const dx = pointer.x - (box.left + box.width / 2);
      const dy = pointer.y - (box.top + box.height / 2);

      if (Math.hypot(dx, dy) < DEAD_ZONE) {
        sector = -1;
        setDirection("center");
        return;
      }

      // Hold the current sector until the pointer is well past its edge.
      const angle = Math.atan2(dy, dx);
      if (
        sector !== -1 &&
        Math.abs(wrap(angle - sector * SECTOR)) < SECTOR / 2 + HYSTERESIS
      ) {
        return;
      }

      sector = (Math.round(angle / SECTOR) + CLOCKWISE.length) % CLOCKWISE.length;
      setDirection(CLOCKWISE[sector]!);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      aim();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("scroll", aim, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("scroll", aim);
    };
  }, []);

  // An idle mascot blinks now and then. Without this a touch device — where
  // there is no pointer to follow — shows a completely static face.
  useEffect(() => {
    if (state !== "idle" || booped) return;
    if (prefersReducedMotion()) return;

    let open: number;
    let shut: number;

    const schedule = () => {
      const delay =
        BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
      open = window.setTimeout(() => {
        setBlinking(true);
        shut = window.setTimeout(() => {
          setBlinking(false);
          schedule();
        }, BLINK_MS);
      }, delay);
    };

    schedule();
    return () => {
      window.clearTimeout(open);
      window.clearTimeout(shut);
      setBlinking(false);
    };
  }, [state, booped]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach(window.clearTimeout);
  }, []);

  const boop = () => {
    timersRef.current.forEach(window.clearTimeout);
    timersRef.current = [];

    const later = (ms: number, next: Reaction | null) => {
      timersRef.current.push(window.setTimeout(() => setBooped(next), ms));
    };

    const now = Date.now();
    const boops = boopsRef.current;
    boops.count = now - boops.at < DIZZY_WINDOW ? boops.count + 1 : 1;
    boops.at = now;

    if (boops.count >= DIZZY_AFTER) {
      boops.count = 0;
      setBooped("dizzy");
      later(DIZZY_END, null);
    } else {
      setBooped("blink");
      later(BOOP_PAYOFF, PAYOFFS[(boops.count - 1) % PAYOFFS.length]!);
      later(BOOP_END, null);
    }

    if (prefersReducedMotion()) return;

    // Per-keyframe easing with the effect itself linear: an easing on the
    // effect would reinterpret every offset and front-load the whole bounce.
    squashRef.current?.animate(SQUASH, { duration: SQUASH_MS, easing: "linear" });
  };

  // A boop is the person's own doing, so it outranks whatever the PAL is up to.
  const reaction =
    booped ?? STATE_REACTION[state] ?? (blinking ? "blink" : null);

  const motion =
    prefersReducedMotion() || booped
      ? undefined
      : state === "thinking"
        ? "brainpal-mascot-think 1.4s ease-in-out infinite"
        : state === "speaking"
          ? "brainpal-mascot-speak 0.9s ease-in-out infinite"
          : undefined;

  const inner = (
    <span
      ref={squashRef}
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        height: "100%",
        transformOrigin: "50% 78%",
        animation: motion,
      }}
    >
      <span
        style={{
          ...layer,
          backgroundImage: `url(${directions})`,
          ...cell(DIRECTIONS.indexOf(direction)),
          opacity: reaction ? 0 : 1,
        }}
      />
      <span
        style={{
          ...layer,
          backgroundImage: `url(${reactions})`,
          ...cell(REACTIONS.indexOf(reaction ?? "blink")),
          opacity: reaction ? 1 : 0,
        }}
      />
    </span>
  );

  const frame: CSSProperties = {
    position: "relative",
    display: "block",
    flexShrink: 0,
    width: size,
    height: size,
    padding: 0,
    border: 0,
    background: "transparent",
    appearance: "none",
    userSelect: "none",
  };

  if (!interactive) {
    return (
      <span
        ref={rootRef as React.Ref<HTMLSpanElement>}
        className={className}
        style={frame}
        role="img"
        aria-label={label}
      >
        {inner}
      </span>
    );
  }

  return (
    <button
      ref={rootRef as React.Ref<HTMLButtonElement>}
      type="button"
      onClick={boop}
      aria-label={label}
      className={className}
      style={{ ...frame, cursor: "pointer" }}
    >
      {inner}
    </button>
  );
}

/** Keyframes the mascot's state animations refer to. Injected once by the app. */
export const MASCOT_KEYFRAMES = `
@keyframes brainpal-mascot-think {
  0%, 100% { transform: translateY(0) }
  50%      { transform: translateY(-6%) }
}
@keyframes brainpal-mascot-speak {
  0%, 100% { transform: scale(1, 1) }
  50%      { transform: scale(1.04, 0.97) }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes brainpal-mascot-think { 0%, 100% { transform: none } }
  @keyframes brainpal-mascot-speak { 0%, 100% { transform: none } }
}
`;
