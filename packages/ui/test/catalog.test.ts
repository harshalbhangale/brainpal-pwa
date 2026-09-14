import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { AvatarSelection } from "@brainpal/contracts";

import {
  ASSET_VERSION,
  AVAILABLE_STYLES,
  MASCOTS,
  findMascot,
  isApproved,
  sheetsFor,
} from "../dist/index.js";

const PUBLIC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/public",
);

test("the catalog stays a short, vetted list", () => {
  // The avatar doc calls for roughly six to twelve approved characters rather
  // than an open generator pointed at children.
  assert.ok(MASCOTS.length >= 6 && MASCOTS.length <= 12);
  assert.equal(new Set(MASCOTS.map((m) => m.id)).size, MASCOTS.length);
});

test("an unapproved mascot id is not accepted", () => {
  assert.equal(isApproved("fox"), true);
  assert.equal(isApproved("dragon"), false);
  assert.equal(isApproved(null), false);
  assert.equal(findMascot("dragon"), undefined);
});

test("every catalog entry has art on disk for every available style", async () => {
  // Catches the failure the wrapper cannot: a character offered in the picker
  // whose sprite sheets were never generated.
  for (const style of AVAILABLE_STYLES) {
    const files = new Set(
      await readdir(resolve(PUBLIC, `mascots/v${ASSET_VERSION}/${style}`)),
    );
    for (const mascot of MASCOTS) {
      const { directions, reactions } = sheetsFor(mascot.id, style);
      assert.ok(
        files.has(directions.split("/").pop()!),
        `${mascot.id} is missing its ${style} directions sheet`,
      );
      assert.ok(
        files.has(reactions.split("/").pop()!),
        `${mascot.id} is missing its ${style} reactions sheet`,
      );
    }
  }
});

test("a catalog selection satisfies the stored contract", () => {
  for (const mascot of MASCOTS) {
    for (const style of AVAILABLE_STYLES) {
      const parsed = AvatarSelection.safeParse({
        mascotId: mascot.id,
        style,
        version: ASSET_VERSION,
      });
      assert.equal(parsed.success, true, `${mascot.id}/${style} is not storable`);
    }
  }
});

test("asset paths carry the version, so art can be replaced in place", () => {
  const v1 = sheetsFor("fox", "colour", 1);
  const v2 = sheetsFor("fox", "colour", 2);
  assert.match(v1.directions, /\/v1\/colour\/fox\.directions\.svg$/);
  assert.match(v2.directions, /\/v2\/colour\/fox\.directions\.svg$/);
  assert.notEqual(v1.directions, v2.directions);
});
