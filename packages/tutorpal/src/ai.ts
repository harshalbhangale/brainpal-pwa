import { modelFor } from "@brainpal/brainpal";
import { generateObject } from "ai";
import { z } from "zod";

export interface ExtractedSection {
  heading: string | null;
  text: string;
  confidence: number;
  uncertainParts: string[];
  sourceRef: string;
}

export interface SourceSection {
  id: string;
  heading: string | null;
  text: string;
}

export interface GeneratedCard {
  front: string;
  back: string;
  sectionId: string | null;
}

export interface GeneratedQuestion {
  type: "mcq" | "short";
  prompt: string;
  options: string[] | null;
  answer: string;
  hint: string;
  explanation: string;
  sectionId: string | null;
}

export interface ShortAnswerMark {
  correct: boolean;
  confidence: number;
  feedback: string;
}

/** Everything TutorPAL asks a model for. One seam, so tests can swap in a deterministic stand-in. */
export interface TutorAi {
  read(bytes: Uint8Array, mediaType: string, sourceRef: string): Promise<ExtractedSection[]>;
  makeFlashcards(sections: SourceSection[], count: number): Promise<GeneratedCard[]>;
  makeQuiz(sections: SourceSection[], count: number, difficulty: string): Promise<GeneratedQuestion[]>;
  markShortAnswer(question: { prompt: string; answer: string }, given: string, sourceText: string): Promise<ShortAnswerMark>;
}

const Read = z.object({
  sections: z
    .array(
      z.object({
        heading: z.string().nullable(),
        text: z.string(),
        confidence: z.number().min(0).max(1),
        uncertainParts: z.array(z.string()),
      }),
    )
    .max(60),
});

const Cards = z.object({
  cards: z.array(z.object({ front: z.string(), back: z.string(), section: z.number().int() })),
});

const Quiz = z.object({
  questions: z.array(
    z.object({
      type: z.enum(["mcq", "short"]),
      prompt: z.string(),
      options: z.array(z.string()).nullable(),
      answer: z.string(),
      hint: z.string(),
      explanation: z.string(),
      section: z.number().int(),
    }),
  ),
});

const Mark = z.object({
  correct: z.boolean(),
  confidence: z.number().min(0).max(1),
  feedback: z.string(),
});

const READ_SYSTEM = `You transcribe a child's learning material — worksheets, notes, textbook pages — exactly.
Split it into sections the way the page does: a heading and its content, or one question each.
Copy the text faithfully, including numbers and maths notation. Never solve, correct or add anything.
For each section give your confidence (0 to 1) that the transcription is exact, and list in uncertainParts any words or numbers you could not read clearly.
Handwriting, blur, glare and cut-off edges all lower confidence.`;

const GROUNDING = `Use only what the material says. Do not add facts it does not contain.
"section" is the number of the section a card or question comes from.`;

function numbered(sections: SourceSection[]): string {
  return sections.map((s, i) => `[${i + 1}]${s.heading ? ` ${s.heading}` : ""}\n${s.text}`).join("\n\n");
}

/** Model answers cite sections by number; only a real section number survives. */
function sectionIdAt(sections: SourceSection[], n: number): string | null {
  return sections[n - 1]?.id ?? null;
}

export class OpenAiTutor implements TutorAi {
  async read(bytes: Uint8Array, mediaType: string, sourceRef: string): Promise<ExtractedSection[]> {
    const file =
      mediaType === "application/pdf"
        ? { type: "file" as const, data: bytes, mediaType }
        : { type: "image" as const, image: bytes, mediaType };
    const { object } = await generateObject({
      model: modelFor("vision"),
      schema: Read,
      system: READ_SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: "Transcribe this material." }, file] }],
    });
    return object.sections
      .filter((s) => s.text.trim().length > 0)
      .map((s) => ({ ...s, sourceRef }));
  }

  async makeFlashcards(sections: SourceSection[], count: number): Promise<GeneratedCard[]> {
    const { object } = await generateObject({
      model: modelFor("balanced"),
      schema: Cards,
      system: `You write flashcards for a child from their own learning material. One idea per card: a short question or prompt on the front, the answer briefly on the back.\n${GROUNDING}`,
      prompt: `${numbered(sections)}\n\nWrite up to ${count} flashcards. Never write two cards for the same fact: fewer cards are better than repeats.`,
    });
    return object.cards
      .map((c) => ({ front: c.front.trim(), back: c.back.trim(), sectionId: sectionIdAt(sections, c.section) }))
      .filter((c) => c.front && c.back && c.sectionId);
  }

  async makeQuiz(sections: SourceSection[], count: number, difficulty: string): Promise<GeneratedQuestion[]> {
    const { object } = await generateObject({
      model: modelFor("balanced"),
      schema: Quiz,
      system:
        `You write a ${difficulty} quiz for a child from their own learning material. Every question must be answerable from the material.\n` +
        `Mix multiple-choice ("mcq": exactly 4 options, with "answer" copied exactly from one of them) and short-answer ("short": options null) questions.\n` +
        `"hint" nudges towards the method without ever stating the answer. "explanation" shows how to reach the answer.\n${GROUNDING}`,
      prompt: `${numbered(sections)}\n\nWrite ${count} questions.`,
    });
    return object.questions
      .map((q) => ({
        type: q.type,
        prompt: q.prompt.trim(),
        options: q.type === "mcq" ? q.options : null,
        answer: q.answer.trim(),
        hint: q.hint.trim(),
        explanation: q.explanation.trim(),
        sectionId: sectionIdAt(sections, q.section),
      }))
      .filter(
        (q) =>
          q.prompt &&
          q.answer &&
          q.sectionId &&
          (q.type === "short" || (q.options?.length === 4 && q.options.includes(q.answer))),
      );
  }

  async markShortAnswer(
    question: { prompt: string; answer: string },
    given: string,
    sourceText: string,
  ): Promise<ShortAnswerMark> {
    const { object } = await generateObject({
      model: modelFor("balanced"),
      schema: Mark,
      system:
        "You mark a child's short answer against the expected answer and the source material. " +
        "Accept equivalent answers: different wording, equivalent numbers or units. Give your confidence (0 to 1) in the mark. " +
        "If the answer is wrong, the feedback explains what went wrong and gives a nudge — never state the correct answer. " +
        "If it is right, the feedback is one short encouraging sentence.",
      prompt: `Question: ${question.prompt}\nExpected answer: ${question.answer}\nSource: ${sourceText}\nChild's answer: ${given}`,
    });
    return object;
  }
}

let ai: TutorAi | undefined;

export function tutorAi(): TutorAi {
  if (!ai) ai = new OpenAiTutor();
  return ai;
}

export function setTutorAi(next: TutorAi): void {
  ai = next;
}
