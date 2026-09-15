import { readFileSync } from "node:fs";

import { runTurn } from "../dist/index.js";

/**
 * MoneyPAL evaluation: real questions against a live model, checked for the
 * owning PAL, required facts, forbidden claims, and any dollar amount that
 * is in neither the ledger facts nor the question. Not part of `test`: it
 * needs a model and answers vary run to run, so it is a report, run by hand.
 */

interface EvalCase {
  id: string;
  role: "parent" | "child";
  speaker: string;
  question: string;
  facts: string;
  expectOwner?: string;
  mustInclude?: string[];
  mustNotInclude?: string[];
}

const cases: EvalCase[] = JSON.parse(readFileSync(new URL("./moneypal.cases.json", import.meta.url), "utf8"));

const AMOUNT = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;
const normalise = (amount: string) => amount.replace(/[\s,]/g, "").replace(/\.0+$/, "");

/** Amounts the answer states that appear in neither the facts nor the question: invented or derived. */
function unsupportedAmounts(answer: string, allowed: string): string[] {
  const known = new Set((allowed.match(AMOUNT) ?? []).map(normalise));
  return [...new Set((answer.match(AMOUNT) ?? []).map(normalise))].filter((a) => !known.has(a));
}

let failures = 0;

for (const c of cases) {
  let owner = "";
  let answer = "";
  let error = "";
  for await (const event of runTurn({
    text: c.question,
    speakerName: c.speaker,
    speakerRole: c.role,
    activePals: new Set(["moneypal", "tutorpal"]),
    moneyFacts: c.facts,
  })) {
    if (event.type === "routed") owner = event.ownerPal;
    else if (event.type === "delta") answer += event.text;
    else if (event.type === "error") error = `${event.code}: ${event.message}`;
  }

  const problems: string[] = [];
  if (error) problems.push(error);
  if (c.expectOwner && owner !== c.expectOwner) problems.push(`routed to ${owner}, expected ${c.expectOwner}`);
  for (const pattern of c.mustInclude ?? []) {
    if (!new RegExp(pattern, "i").test(answer)) problems.push(`missing /${pattern}/`);
  }
  for (const pattern of c.mustNotInclude ?? []) {
    if (new RegExp(pattern, "i").test(answer)) problems.push(`contains /${pattern}/`);
  }
  const unsupported = unsupportedAmounts(answer, `${c.facts} ${c.question}`);
  if (unsupported.length > 0) problems.push(`amounts not in the facts: ${unsupported.join(", ")}`);

  if (problems.length > 0) failures++;
  console.log(`${problems.length === 0 ? "PASS" : "FAIL"}  ${c.id}  [${owner || "?"}]`);
  console.log(`      ${answer.replace(/\s+/g, " ").trim()}`);
  for (const p of problems) console.log(`      ✗ ${p}`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exitCode = failures > 0 ? 1 : 0;
