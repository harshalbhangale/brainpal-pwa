import assert from "node:assert/strict";
import { test } from "node:test";

import { makeCiter } from "../dist/ai.js";

const cite = makeCiter([
  { id: "s1", heading: null, text: "The heart pumps blood around the body through arteries and veins." },
  { id: "s2", heading: null, text: "Photosynthesis happens in the chloroplasts, where plants make glucose from sunlight." },
  { id: "s3", heading: "Volcanoes", text: "Volcanoes erupt when magma rises through cracks in the crust." },
]);

test("a point cited to the wrong section is moved to the one its words come from", () => {
  assert.equal(cite("s1", "Plants make glucose in their chloroplasts"), "s2");
  assert.equal(cite("s1", "Magma rises through cracks in the crust"), "s3");
});

test("a correct citation is kept, and a missing one is filled in", () => {
  assert.equal(cite("s2", "Plants make glucose in their chloroplasts"), "s2");
  assert.equal(cite(null, "Arteries carry blood from the heart"), "s1");
});

test("with nothing to go on, the model's citation stands", () => {
  assert.equal(cite("s3", "Remember to revise this"), "s3");
  assert.equal(makeCiter([{ id: "only", heading: null, text: "x" }])(null, "anything"), "only");
});
