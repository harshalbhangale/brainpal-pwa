#!/usr/bin/env node
/**
 * Generates placeholder sprite sheets for the approved mascot catalog.
 *
 * These are stand-ins so the avatar system can be built and tested before real
 * art exists. Replacing them means dropping new files at the same paths and
 * bumping ASSET_VERSION — no code and no stored member row changes.
 *
 * Each sheet is a 3x3 grid. The renderer sets background-size: 300% and steps
 * background-position in 50% increments, so cell n sits at
 * (n % 3, floor(n / 3)) of a square image.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CELL = 128;
const GRID = 3;
const SIZE = CELL * GRID;

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/public/mascots/v1/colour",
);

/** Order must match DIRECTIONS in mascot.tsx. */
const GAZE = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],  [0, 0],  [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

/** Order must match REACTIONS in mascot.tsx. */
const REACTIONS = [
  "blink", "heart", "sparkle",
  "surprised", "wink", "bashful",
  "sleepy", "dizzy", "delighted",
];

const CHARACTERS = [
  { id: "fox", tint: "#E2703A", belly: "#F6D9C6", ear: "pointed" },
  { id: "owl", tint: "#7C6A9C", belly: "#E4DCEF", ear: "tufted" },
  { id: "cat", tint: "#4E8FA8", belly: "#D8ECF2", ear: "pointed" },
  { id: "bear", tint: "#8A6242", belly: "#EADBCB", ear: "round" },
  { id: "frog", tint: "#5B9A54", belly: "#DDEFD6", ear: "none" },
  { id: "panda", tint: "#5A5A66", belly: "#F0F0F3", ear: "round" },
];

const INK = "#2A2A30";

function ears(kind, tint) {
  if (kind === "none") return "";
  if (kind === "tufted") {
    return `<path d="M30 40 L44 14 L56 42 Z" fill="${tint}"/>
            <path d="M98 40 L84 14 L72 42 Z" fill="${tint}"/>`;
  }
  if (kind === "round") {
    return `<circle cx="34" cy="34" r="16" fill="${tint}"/>
            <circle cx="94" cy="34" r="16" fill="${tint}"/>`;
  }
  return `<path d="M28 44 L38 16 L58 36 Z" fill="${tint}"/>
          <path d="M100 44 L90 16 L70 36 Z" fill="${tint}"/>`;
}

function head(character) {
  return `${ears(character.ear, character.tint)}
    <circle cx="64" cy="70" r="40" fill="${character.tint}"/>
    <ellipse cx="64" cy="82" rx="26" ry="22" fill="${character.belly}"/>`;
}

/**
 * An open eye whose pupil is offset toward where the mascot is looking.
 *
 * The offsets are large on purpose. At avatar size — often 40px — a couple of
 * pixels of pupil travel is invisible, and nine identical-looking cells are
 * worse than one. The eyes widen slightly toward the gaze too, which reads as a
 * turn of the head rather than a swivel of the eyes alone.
 */
function eyes(dx, dy) {
  const ox = dx * 6.5;
  const oy = dy * 5;
  const lx = 52 + dx * 2.5;
  const rx = 76 + dx * 2.5;
  const y = 66 + dy * 2;
  return `<circle cx="${lx}" cy="${y}" r="8.5" fill="#fff"/>
          <circle cx="${rx}" cy="${y}" r="8.5" fill="#fff"/>
          <circle cx="${lx + ox}" cy="${y + oy}" r="4.6" fill="${INK}"/>
          <circle cx="${rx + ox}" cy="${y + oy}" r="4.6" fill="${INK}"/>`;
}

function mouth(path) {
  return `<path d="${path}" stroke="${INK}" stroke-width="3"
    stroke-linecap="round" fill="none"/>`;
}

const SHUT = (cx) =>
  `<path d="M${cx - 8} 66 Q ${cx} 71 ${cx + 8} 66" stroke="${INK}"
     stroke-width="3" stroke-linecap="round" fill="none"/>`;

function reactionFace(kind) {
  switch (kind) {
    case "blink":
      return SHUT(52) + SHUT(76) + mouth("M54 90 Q64 96 74 90");
    case "heart":
      return (
        SHUT(52) + SHUT(76) +
        mouth("M54 90 Q64 98 74 90") +
        `<path d="M96 40 a6 6 0 0 1 10 -4 a6 6 0 0 1 10 4 q0 8 -10 14 q-10 -6 -10 -14 Z" fill="#D9536A"/>`
      );
    case "sparkle":
      return (
        eyes(0, -0.6) +
        mouth("M54 90 Q64 98 74 90") +
        `<path d="M104 32 l3 8 l8 3 l-8 3 l-3 8 l-3 -8 l-8 -3 l8 -3 Z" fill="#F2C14E"/>
         <path d="M24 46 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 l5 -2 Z" fill="#F2C14E"/>`
      );
    case "surprised":
      return (
        `<circle cx="52" cy="66" r="9" fill="#fff"/><circle cx="76" cy="66" r="9" fill="#fff"/>
         <circle cx="52" cy="66" r="5" fill="${INK}"/><circle cx="76" cy="66" r="5" fill="${INK}"/>` +
        `<ellipse cx="64" cy="92" rx="7" ry="9" fill="${INK}"/>`
      );
    case "wink":
      return (
        `<circle cx="52" cy="66" r="8" fill="#fff"/><circle cx="52" cy="66" r="4.2" fill="${INK}"/>` +
        SHUT(76) + mouth("M54 90 Q64 97 74 90")
      );
    case "bashful":
      return (
        SHUT(52) + SHUT(76) +
        mouth("M56 91 Q64 95 72 91") +
        `<ellipse cx="40" cy="80" rx="9" ry="5" fill="#E58A8A" opacity="0.65"/>
         <ellipse cx="88" cy="80" rx="9" ry="5" fill="#E58A8A" opacity="0.65"/>`
      );
    case "sleepy":
      return (
        SHUT(52) + SHUT(76) +
        mouth("M58 92 Q64 96 70 92") +
        `<text x="92" y="40" font-family="system-ui, sans-serif" font-size="20"
           fill="${INK}" opacity="0.7">z</text>`
      );
    case "dizzy":
      return (
        `<path d="M46 60 l12 12 M58 60 l-12 12" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
         <path d="M70 60 l12 12 M82 60 l-12 12" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>` +
        mouth("M54 92 Q59 87 64 92 Q69 97 74 92")
      );
    case "delighted":
      return (
        `<path d="M44 68 Q52 58 60 68" stroke="${INK}" stroke-width="3.4" stroke-linecap="round" fill="none"/>
         <path d="M68 68 Q76 58 84 68" stroke="${INK}" stroke-width="3.4" stroke-linecap="round" fill="none"/>` +
        `<path d="M52 88 Q64 100 76 88 Z" fill="${INK}"/>`
      );
    default:
      return eyes(0, 0);
  }
}

function sheet(character, faces) {
  const cells = faces
    .map((face, index) => {
      const x = (index % GRID) * CELL;
      const y = Math.floor(index / GRID) * CELL;
      return `<g transform="translate(${x} ${y})">${head(character)}${face}</g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<title>${character.id} placeholder sprite sheet</title>
${cells}
</svg>
`;
}

await mkdir(OUT, { recursive: true });

for (const character of CHARACTERS) {
  const directions = sheet(
    character,
    GAZE.map(([dx, dy]) =>
      eyes(dx, dy) + mouth(`M${56 + dx * 2} 90 Q${64 + dx * 2} 95 ${72 + dx * 2} 90`),
    ),
  );
  const reactions = sheet(character, REACTIONS.map(reactionFace));

  await writeFile(`${OUT}/${character.id}.directions.svg`, directions, "utf8");
  await writeFile(`${OUT}/${character.id}.reactions.svg`, reactions, "utf8");
}

console.log(`generated ${CHARACTERS.length * 2} sheets in ${OUT}`);
