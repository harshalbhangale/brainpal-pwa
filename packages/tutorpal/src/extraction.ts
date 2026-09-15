import { extractText, getDocumentProxy } from "unpdf";

import { type ExtractedSection, tutorAi } from "./ai.js";

const MAX_SECTION_CHARS = 20_000;
// Per page, not in total: a short digital worksheet ("7 x 8 = 56") is still
// digital, while a scan whose only text layer is a page number is not.
const SCANNED_BELOW_CHARS_PER_PAGE = 10;

/**
 * A digital PDF already contains its text, so it is read directly: exact, free
 * and confidence 1. Only a scanned PDF — one with next to no text layer — goes
 * to the vision model.
 */
export async function extractPdf(bytes: Uint8Array): Promise<{ method: "pdf_text" | "vision"; sections: ExtractedSection[] }> {
  // pdf.js may detach the buffer it is given, and the bytes can still be needed for the vision fallback.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((t) => t.trim());

  const characters = pages.join("").replace(/\s/g, "").length;
  if (characters / Math.max(pages.length, 1) < SCANNED_BELOW_CHARS_PER_PAGE) {
    return { method: "vision", sections: await tutorAi().read(bytes, "application/pdf", "PDF") };
  }

  const sections = pages
    .map((page, i) => ({ page, number: i + 1 }))
    .filter(({ page }) => page.length > 0)
    .map(({ page, number }) => ({
      heading: null,
      text: page.slice(0, MAX_SECTION_CHARS),
      confidence: 1,
      uncertainParts: [],
      sourceRef: `page ${number}`,
    }));
  return { method: "pdf_text", sections };
}
