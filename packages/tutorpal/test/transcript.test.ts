import assert from "node:assert/strict";
import { test } from "node:test";

import { textSections, transcriptSections, youtubeVideoId } from "../dist/transcript.js";

test("every usual form of YouTube link gives the video id, and nothing else does", () => {
  const id = "8aGhZQkoFbQ";
  for (const link of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
  ]) {
    assert.equal(youtubeVideoId(link), id, link);
  }
  for (const link of ["not a link", "https://vimeo.com/12345", "https://www.youtube.com/watch?v=short", "https://evil.example/watch?v=8aGhZQkoFbQ"]) {
    assert.equal(youtubeVideoId(link), null, link);
  }
});

test("a transcript becomes two-minute stretches, each cited by its time", () => {
  const segments = Array.from({ length: 30 }, (_, i) => ({ startMs: i * 10_000, text: `line ${i}` }));
  const sections = transcriptSections({ videoId: "x", title: "t", auto: false, segments });
  assert.equal(sections.length, 3);
  assert.equal(sections[0]!.sourceRef, "0:00–1:50");
  assert.equal(sections[1]!.sourceRef, "2:00–3:50");
  assert.equal(sections[0]!.confidence, 1);
  assert.ok(sections[0]!.text.startsWith("line 0 line 1"));
});

test("machine captions are marked a little less certain, but not held for review", () => {
  const [section] = transcriptSections({ videoId: "x", title: "t", auto: true, segments: [{ startMs: 3_723_000, text: "hello" }] });
  assert.equal(section!.confidence, 0.9);
  assert.equal(section!.sourceRef, "1:02:03–1:02:03");
});

test("pasted notes are split at blank lines into parts of a readable size", () => {
  const sections = textSections(`Photosynthesis\nPlants make food.\n\n\n${"a".repeat(1_495)}\n\nLast part`);
  assert.equal(sections.length, 3);
  assert.equal(sections[0]!.text, "Photosynthesis\nPlants make food.");
  assert.equal(sections[2]!.text, "Last part");
  assert.deepEqual(sections.map((s) => s.sourceRef), ["part 1", "part 2", "part 3"]);
  assert.equal(textSections("   \n\n  ").length, 0);
});
