import { type Database, cheatsheets } from "@brainpal/database";
import { and, desc, eq } from "drizzle-orm";

import { type Actor, assertVisible, groundedSections, isParent, notFound, sourceRefs } from "./access.js";
import { tutorAi } from "./ai.js";
import { TutorError } from "./errors.js";

type Sheet = typeof cheatsheets.$inferSelect;

async function publicSheet(db: Database, sheet: Sheet) {
  const refs = await sourceRefs(db, sheet.blocks.flatMap((b) => b.points.map((p) => p.sectionId)));
  return {
    id: sheet.id,
    title: sheet.title,
    ownerMemberId: sheet.ownerMemberId,
    documentId: sheet.documentId,
    createdAt: sheet.createdAt.toISOString(),
    blocks: sheet.blocks.map((b) => ({
      heading: b.heading,
      points: b.points.map((p) => ({
        text: p.text,
        sectionId: p.sectionId,
        sourceRef: (p.sectionId && refs.get(p.sectionId)) || null,
      })),
    })),
  };
}

/** A one-page summary, made only from checked material, with each point citing where it came from. */
export async function createCheatsheet(db: Database, actor: Actor, documentId: string) {
  const { source, sections } = await groundedSections(db, actor, documentId);
  const blocks = await tutorAi().makeCheatsheet(sections);
  if (blocks.length === 0) throw new TutorError("NOTHING_GENERATED", "TutorPAL could not make a cheatsheet from this material.");

  const [sheet] = await db
    .insert(cheatsheets)
    .values({
      familyId: actor.familyId,
      ownerMemberId: source.ownerMemberId,
      documentId,
      title: `${source.title} — cheatsheet`,
      blocks,
      createdByMemberId: actor.memberId,
    })
    .returning();
  return publicSheet(db, sheet!);
}

export async function getCheatsheet(db: Database, actor: Actor, id: string) {
  const [sheet] = await db
    .select()
    .from(cheatsheets)
    .where(and(eq(cheatsheets.id, id), eq(cheatsheets.familyId, actor.familyId)))
    .limit(1);
  if (!sheet) throw notFound();
  assertVisible(actor, sheet.ownerMemberId);
  return publicSheet(db, sheet);
}

export async function listCheatsheets(db: Database, actor: Actor) {
  return db
    .select({
      id: cheatsheets.id,
      title: cheatsheets.title,
      ownerMemberId: cheatsheets.ownerMemberId,
      documentId: cheatsheets.documentId,
      createdAt: cheatsheets.createdAt,
    })
    .from(cheatsheets)
    .where(
      and(
        eq(cheatsheets.familyId, actor.familyId),
        ...(isParent(actor) ? [] : [eq(cheatsheets.ownerMemberId, actor.memberId)]),
      ),
    )
    .orderBy(desc(cheatsheets.createdAt));
}
