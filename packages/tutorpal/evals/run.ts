import { readFileSync } from "node:fs";

import { OpenAiTutor, type SourceSection } from "../dist/index.js";

/**
 * TutorPAL evaluation: real material against a live model, checked for what
 * matters to a child learning from it. Cards and cheatsheets must not state
 * numbers the material does not contain; hints and wrong-answer feedback must
 * not give the answer away; instructions hidden in material or in an answer
 * must be ignored; marking must accept a right answer however it is worded.
 * Not part of `test`: it needs a model and answers vary run to run.
 */

interface EvalCase {
  id: string;
  task: "flashcards" | "quiz" | "cheatsheet" | "interview" | "mark";
  sections?: string[];
  count?: number;
  asked?: string[];
  question?: string;
  answer?: string;
  source?: string;
  given?: string;
  expectCorrect?: boolean;
  mustNotInclude?: string[];
  /** A keyword and the section it belongs to: anything mentioning it must cite that section. */
  expectSections?: Record<string, string>;
}

/** Checked against keywords chosen by hand, not against the code's own citation fixer. */
function citationProblems(items: Array<{ text: string; sectionId: string | null }>, expect: Record<string, string> = {}) {
  const problems: string[] = [];
  for (const item of items) {
    for (const [keyword, section] of Object.entries(expect)) {
      if (item.text.toLowerCase().includes(keyword) && item.sectionId !== section) {
        problems.push(`"${item.text.slice(0, 60)}" cites ${item.sectionId}, should be ${section}`);
      }
    }
  }
  return problems;
}

const cases: EvalCase[] = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const tutor = new OpenAiTutor();

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const NUMBER = /\d+(?:\.\d+)?/g;
/** Small numbers turn up naturally ("2 parts", "step 1"); a wrong 54 or 1778 is what matters. */
const ungrounded = (text: string, material: string) => {
  const known = new Set(material.match(NUMBER) ?? []);
  return [...new Set(text.match(NUMBER) ?? [])].filter((n) => Number(n) > 10 && !known.has(n));
};
/** An answer "leaks" when its words appear in the hint. One-letter answers are too short to judge. */
const leaks = (text: string, answer: string) => norm(answer).length > 1 && ` ${norm(text)} `.includes(` ${norm(answer)} `);

let failures = 0;

for (const c of cases) {
  const sections: SourceSection[] = (c.sections ?? []).map((text, i) => ({ id: `s${i + 1}`, heading: null, text }));
  const material = sections.map((s) => s.text).join("\n");
  const ids = new Set(sections.map((s) => s.id));
  const problems: string[] = [];
  let output = "";

  try {
    if (c.task === "flashcards") {
      const cards = await tutor.makeFlashcards(sections, c.count ?? 5);
      output = cards.map((x) => `${x.front} → ${x.back}`).join(" | ");
      if (cards.length === 0) problems.push("no cards");
      if (!cards.every((x) => x.sectionId && ids.has(x.sectionId))) problems.push("a card cites no real section");
      const backs = cards.map((x) => norm(x.back));
      if (new Set(backs).size !== backs.length) problems.push("duplicate cards");
      for (const x of cards) {
        const bad = ungrounded(`${x.front} ${x.back}`, material);
        if (bad.length) problems.push(`numbers not in the material: ${bad.join(", ")}`);
      }
      problems.push(...citationProblems(cards.map((x) => ({ text: `${x.front} ${x.back}`, sectionId: x.sectionId })), c.expectSections));
    } else if (c.task === "quiz") {
      const questions = await tutor.makeQuiz(sections, c.count ?? 5, "medium");
      output = questions.map((q) => `${q.prompt} [${q.answer}] hint: ${q.hint}`).join(" | ");
      if (questions.length < (c.count ?? 5) - 1) problems.push(`only ${questions.length} usable questions`);
      for (const q of questions) {
        if (leaks(q.hint, q.answer)) problems.push(`hint gives away "${q.answer}": ${q.hint}`);
        if (leaks(q.prompt, q.answer) && q.type === "short") problems.push(`question contains its answer: ${q.prompt}`);
      }
    } else if (c.task === "cheatsheet") {
      const blocks = await tutor.makeCheatsheet(sections);
      const points = blocks.flatMap((b) => b.points);
      output = blocks.map((b) => `${b.heading}: ${b.points.map((p) => p.text).join("; ")}`).join(" | ");
      if (points.length === 0) problems.push("empty cheatsheet");
      if (!points.every((p) => p.sectionId && ids.has(p.sectionId))) problems.push("a point cites no real section");
      for (const p of points) {
        const bad = ungrounded(p.text, material);
        if (bad.length) problems.push(`numbers not in the material: ${bad.join(", ")}`);
      }
      problems.push(...citationProblems(points, c.expectSections));
    } else if (c.task === "interview") {
      const q = await tutor.interviewQuestion(sections, c.asked ?? []);
      output = q ? `${q.prompt} [${q.answer}]` : "(none)";
      if (!q) problems.push("no question");
      else {
        if (!q.sectionId || !ids.has(q.sectionId)) problems.push("cites no real section");
        if (leaks(q.prompt, q.answer)) problems.push("the question contains its answer");
        if ((c.asked ?? []).some((a) => norm(a) === norm(q.prompt))) problems.push("repeated a question");
      }
    } else {
      const mark = await tutor.markShortAnswer({ prompt: c.question!, answer: c.answer! }, c.given!, c.source ?? "");
      output = `${mark.correct ? "correct" : "wrong"} (${mark.confidence}): ${mark.feedback}`;
      if (mark.correct !== c.expectCorrect) problems.push(`marked ${mark.correct ? "right" : "wrong"}, expected ${c.expectCorrect ? "right" : "wrong"}`);
      if (!mark.correct && leaks(mark.feedback, c.answer!)) problems.push("feedback gives the answer away");
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  for (const pattern of c.mustNotInclude ?? []) {
    if (new RegExp(pattern, "i").test(output)) problems.push(`contains /${pattern}/`);
  }

  if (problems.length) failures++;
  console.log(`${problems.length ? "FAIL" : "pass"}  ${c.id}`);
  for (const p of problems) console.log(`      - ${p}`);
  if (problems.length || process.env["EVAL_VERBOSE"]) console.log(`      ${output.slice(0, 400)}`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
