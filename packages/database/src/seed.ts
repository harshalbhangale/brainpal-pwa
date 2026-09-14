import { closePool, getDb } from "./client.js";
import { palRegistry } from "./schema/pals.js";

/** Reference data: the catalog of PALs the product ships with. */
const PALS = [
  {
    id: "brainpal" as const,
    name: "BrainPal",
    description: "Understands what you need and takes it to the right PAL.",
  },
  {
    id: "moneypal" as const,
    name: "MoneyPAL",
    description: "Wallet, chores, savings, allowance and cards.",
  },
  {
    id: "tutorpal" as const,
    name: "TutorPAL",
    description: "Flashcards, cheatsheets, quizzes and practice.",
  },
];

export async function seedPalRegistry() {
  const db = getDb();
  for (const pal of PALS) {
    await db
      .insert(palRegistry)
      .values(pal)
      .onConflictDoUpdate({
        target: palRegistry.id,
        set: { name: pal.name, description: pal.description },
      });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await seedPalRegistry();
    console.log(`seeded ${PALS.length} pals`);
  } finally {
    await closePool();
  }
}
