import assert from "node:assert/strict";
import { test } from "node:test";

import { extractPdf, setTutorAi } from "../dist/index.js";

let visionAsked = "";

// Installed before any test runs: nothing in this file may ever reach a real model.
setTutorAi({
  read: async (_bytes, mediaType, sourceRef) => {
    visionAsked = mediaType;
    return [{ heading: null, text: "handwritten notes", confidence: 0.6, uncertainParts: ["notes"], sourceRef }];
  },
  makeFlashcards: async () => [],
  makeQuiz: async () => [],
  markShortAnswer: async () => ({ correct: false, confidence: 1, feedback: "" }),
});

/** A real, minimal one-page PDF with a text layer. Offsets are computed, so pdf.js reads it like any other. */
function tinyPdf(lines: string[]): Uint8Array {
  const content = lines.length
    ? `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? "0 -16 Td " : ""}(${l}) Tj`).join(" ")} ET`
    : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

test("a digital PDF is read directly, exactly, with page references", async () => {
  const { method, sections } = await extractPdf(tinyPdf(["Times tables", "7 x 8 = 56"]));
  assert.equal(method, "pdf_text");
  assert.equal(sections.length, 1);
  assert.match(sections[0]!.text, /7 x 8 = 56/);
  assert.equal(sections[0]!.confidence, 1);
  assert.equal(sections[0]!.sourceRef, "page 1");
});

test("a scanned PDF with no text layer goes to the vision model", async () => {
  const { method, sections } = await extractPdf(tinyPdf([]));
  assert.equal(method, "vision");
  assert.equal(visionAsked, "application/pdf");
  assert.equal(sections[0]!.text, "handwritten notes");
});

test("a scan whose only text is a page number is still treated as scanned", async () => {
  visionAsked = "";
  const { method } = await extractPdf(tinyPdf(["12"]));
  assert.equal(method, "vision");
  assert.equal(visionAsked, "application/pdf");
});
