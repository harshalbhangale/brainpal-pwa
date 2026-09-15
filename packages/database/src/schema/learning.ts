import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { families, familyMembers } from "./identity.js";

export const learningSourceKind = pgEnum("learning_source_kind", ["pdf", "image", "youtube", "text"]);
export const learningSourceStatus = pgEnum("learning_source_status", ["uploaded", "ready", "failed"]);
export const flashcardState = pgEnum("flashcard_state", ["new", "learning", "review", "known"]);

export const studentProfiles = pgTable(
  "student_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    schoolYear: text("school_year"),
    curriculum: text("curriculum"),
    goals: text("goals"),
    studyTimes: text("study_times"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("student_profiles_member_key").on(table.memberId)],
);

export const subjects = pgTable(
  "subjects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nextExamDate: date("next_exam_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("subjects_member_name_key").on(table.memberId, table.name)],
);

/**
 * An uploaded file. The bytes live in object storage under `storageKey`, never
 * in the database. `ownerMemberId` is the child the material belongs to, which
 * is what scopes who may see it and anything made from it.
 */
export const learningSources = pgTable(
  "learning_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    ownerMemberId: uuid("owner_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    uploadedByMemberId: uuid("uploaded_by_member_id").references(() => familyMembers.id, {
      onDelete: "set null",
    }),
    subjectId: uuid("subject_id").references(() => subjects.id, { onDelete: "set null" }),
    kind: learningSourceKind("kind").notNull(),
    title: text("title").notNull(),
    storageKey: text("storage_key").notNull(),
    /** Where a linked source came from, e.g. the YouTube video. Null for uploads. */
    sourceUrl: text("source_url"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: learningSourceStatus("status").notNull().default("uploaded"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("learning_sources_owner_idx").on(table.ownerMemberId)],
);

/** What was read out of a source. Re-extracting replaces it, sections and all. */
export const learningDocuments = pgTable(
  "learning_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => learningSources.id, { onDelete: "cascade" }),
    /** "pdf_text" when read straight from a digital PDF, "vision" when read by a model. */
    method: text("method").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("learning_documents_source_key").on(table.sourceId)],
);

/**
 * One section of the material. `needsReview` is raised for low-confidence or
 * partly unreadable text, and nothing is generated from a document until every
 * such section has been checked. A correction is kept beside the original.
 */
export const documentSections = pgTable(
  "document_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => learningDocuments.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    heading: text("heading"),
    text: text("text").notNull(),
    correctedText: text("corrected_text"),
    confidence: real("confidence").notNull(),
    needsReview: boolean("needs_review").notNull(),
    uncertainParts: jsonb("uncertain_parts").$type<string[]>(),
    /** Where in the source it came from, e.g. "page 2" or "photo". */
    sourceRef: text("source_ref").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("document_sections_document_idx").on(table.documentId, table.position)],
);

export const flashcardDecks = pgTable(
  "flashcard_decks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    ownerMemberId: uuid("owner_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => learningDocuments.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    createdByMemberId: uuid("created_by_member_id").references(() => familyMembers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("flashcard_decks_owner_idx").on(table.ownerMemberId)],
);

/** The review schedule lives on the card itself, so there is no second record to drift. */
export const flashcards = pgTable(
  "flashcards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deckId: uuid("deck_id")
      .notNull()
      .references(() => flashcardDecks.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    front: text("front").notNull(),
    back: text("back").notNull(),
    sectionId: uuid("section_id").references(() => documentSections.id, { onDelete: "set null" }),
    state: flashcardState("state").notNull().default("new"),
    ease: real("ease").notNull().default(2.5),
    intervalDays: integer("interval_days").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("flashcards_deck_due_idx").on(table.deckId, table.dueAt)],
);

export interface QuizQuestion {
  id: string;
  type: "mcq" | "short";
  prompt: string;
  options?: string[];
  answer: string;
  /** A nudge that never states the answer, shown after a wrong attempt. */
  hint: string;
  explanation: string;
  sectionId: string | null;
}

/** Answers, hints and explanations live here and are stripped before a quiz leaves the server. */
export const quizDefinitions = pgTable(
  "quiz_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    ownerMemberId: uuid("owner_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => learningDocuments.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    difficulty: text("difficulty").notNull(),
    questions: jsonb("questions").$type<QuizQuestion[]>().notNull(),
    createdByMemberId: uuid("created_by_member_id").references(() => familyMembers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("quiz_definitions_owner_idx").on(table.ownerMemberId)],
);

export interface QuizResult {
  questionId: string;
  answer: string;
  correct: boolean;
  confidence: number;
  /** Marked with low confidence: a parent should check it. */
  needsReview: boolean;
  feedback: string;
  revealed: boolean;
}

export const quizAttempts = pgTable(
  "quiz_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizDefinitions.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    results: jsonb("results").$type<QuizResult[]>().notNull(),
    score: integer("score").notNull(),
    total: integer("total").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("quiz_attempts_member_idx").on(table.memberId, table.createdAt)],
);

/** Append-only: one row per answered question or reviewed card. Progress is derived from it. */
export const learningEvidence = pgTable(
  "learning_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => learningDocuments.id, { onDelete: "set null" }),
    sectionId: uuid("section_id").references(() => documentSections.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    refId: uuid("ref_id").notNull(),
    correct: boolean("correct").notNull(),
    confidence: real("confidence").notNull(),
    detail: jsonb("detail"),
    /**
     * Set by a client that recorded the evidence offline and sends it later.
     * Unique per member, so a sync that is retried cannot count a review twice.
     */
    clientRef: uuid("client_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("learning_evidence_member_idx").on(table.memberId, table.createdAt),
    uniqueIndex("learning_evidence_client_ref_key")
      .on(table.memberId, table.clientRef)
      .where(sql`${table.clientRef} is not null`),
  ],
);

export interface NextStep {
  activity: "review_flashcards" | "retry_quiz" | "harder_quiz";
  reason: string;
  sectionIds: string[];
}

export const learningProgress = pgTable(
  "learning_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => learningDocuments.id, { onDelete: "cascade" }),
    /** Share of the last 20 answers on this material that were right. */
    mastery: real("mastery").notNull(),
    nextStep: jsonb("next_step").$type<NextStep>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("learning_progress_member_document_key").on(table.memberId, table.documentId)],
);

/** A weekly class: "Maths, Monday 09:00–09:50". Times are the family's local time. */
export const classSessions = pgTable(
  "class_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    /** 0 = Sunday … 6 = Saturday. */
    weekday: integer("weekday").notNull(),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    location: text("location"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("class_sessions_member_idx").on(table.memberId, table.weekday),
    check("class_sessions_weekday_check", sql`${table.weekday} between 0 and 6`),
    check(
      "class_sessions_times_check",
      sql`${table.startsAt} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${table.endsAt} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${table.endsAt} > ${table.startsAt}`,
    ),
  ],
);

export interface CheatsheetBlock {
  heading: string;
  points: Array<{ text: string; sectionId: string | null }>;
}

/** A one-page summary of a document. Every point names the section it came from. */
export const cheatsheets = pgTable(
  "cheatsheets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    ownerMemberId: uuid("owner_member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => learningDocuments.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    blocks: jsonb("blocks").$type<CheatsheetBlock[]>().notNull(),
    createdByMemberId: uuid("created_by_member_id").references(() => familyMembers.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("cheatsheets_owner_idx").on(table.ownerMemberId)],
);

/**
 * One interview question and how it went. `answer` is what TutorPAL expects
 * and, like a quiz answer, never leaves the server unless it is asked for.
 */
export interface InterviewQuestion {
  id: string;
  prompt: string;
  answer: string;
  sectionId: string | null;
  replies: Array<{ text: string; correct: boolean; confidence: number; feedback: string }>;
  /** Settled: answered right, or out of tries. */
  done: boolean;
  revealed: boolean;
}

export const interviewStatus = pgEnum("interview_status", ["active", "complete"]);

/** A spoken or typed back-and-forth: TutorPAL asks, the child answers, one question at a time. */
export const interviewSessions = pgTable(
  "interview_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => familyMembers.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => learningDocuments.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: interviewStatus("status").notNull().default("active"),
    questionCount: integer("question_count").notNull(),
    questions: jsonb("questions").$type<InterviewQuestion[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("interview_sessions_member_idx").on(table.memberId, table.createdAt)],
);
