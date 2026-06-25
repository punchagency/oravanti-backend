/**
 * Seeds case-type questionnaires from the Master Client Intake Questionnaire PDF
 * (transcribed in ./data/master-intake-questions.ts).
 *
 * For each matter subtype, resolves its candidate DB case types by normalised
 * name and — when found and not already populated — creates a questionnaire with
 * a "Matter Details" section (intake questions) and, where applicable, a
 * "Required Documents" section (file_upload questions).
 *
 * Curated mapping: case types that can't be confidently matched are logged and
 * skipped rather than guessed. Safe to re-run.
 */

import { eq } from "drizzle-orm";
import { db } from "../client";
import {
  caseTypeQuestionnaires,
  caseTypeQuestionnaireSections,
  caseTypeQuestionnaireQuestions,
} from "../schema/questionnaires";
import { practiceAreaCaseTypes } from "../schema/practice-area-case-types";
import {
  MASTER_INTAKE_QUESTIONNAIRE,
  type MasterSubtype,
} from "./data/master-intake-questions";

type QType =
  | "short_text" | "long_text" | "number" | "email" | "phone"
  | "date" | "yes_no" | "file_upload";

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Infer an input type from a question label. */
const inferType = (label: string): QType => {
  const l = label.toLowerCase();
  if (
    /^(is|are|was|were|has|have|had|did|do|does|should|will|can|could|would)\b/.test(
      l,
    )
  ) {
    return "yes_no";
  }
  if (/\b(describe|explain|list|summarize|summarise|nature of|circumstances|reason|how )\b/.test(l)) {
    return "long_text";
  }
  if (/^date\b|\bdate of\b/.test(l) && !/and|,/.test(l)) return "date";
  if (/\bemail\b/.test(l)) return "email";
  if (/\bphone\b/.test(l)) return "phone";
  return "short_text";
};

const buildSections = (subtype: MasterSubtype) => {
  const sections: {
    title: string;
    questions: { label: string; type: QType; isRequired: boolean }[];
  }[] = [
    {
      title: "Matter Details",
      questions: subtype.questions.map((label) => ({
        label,
        type: inferType(label),
        // Yes/No and free-text fields aren't forced required; identifying
        // fields (names/dates) are.
        isRequired: inferType(label) === "short_text",
      })),
    },
  ];

  if (subtype.documents?.length) {
    sections.push({
      title: "Required Documents",
      questions: subtype.documents.map((label) => ({
        label,
        type: "file_upload" as QType,
        isRequired: false,
      })),
    });
  }

  return sections;
};

export async function seedMasterQuestionnaires() {
  // Build a normalised lookup of existing case types by name.
  const caseTypes = await db
    .select({ id: practiceAreaCaseTypes.id, name: practiceAreaCaseTypes.name })
    .from(practiceAreaCaseTypes);
  const byName = new Map(caseTypes.map((ct) => [normalize(ct.name), ct]));

  let created = 0;
  let skippedExisting = 0;
  const unmatched: string[] = [];
  const mappedCaseTypeIds = new Set<string>();

  for (const specialty of MASTER_INTAKE_QUESTIONNAIRE) {
    for (const category of specialty.categories) {
      for (const subtype of category.subtypes) {
        // Resolve the first candidate case type that exists in the DB.
        const match = subtype.caseTypes
          .map((name) => byName.get(normalize(name)))
          .find((ct) => ct != null);

        if (!match) {
          unmatched.push(`${specialty.name} › ${subtype.name}`);
          continue;
        }

        // One questionnaire per case type — don't double-seed if another subtype
        // already claimed it this run, or one already exists in the DB.
        if (mappedCaseTypeIds.has(match.id)) continue;
        mappedCaseTypeIds.add(match.id);

        const [existing] = await db
          .select({ id: caseTypeQuestionnaires.id })
          .from(caseTypeQuestionnaires)
          .where(eq(caseTypeQuestionnaires.caseTypeId, match.id))
          .limit(1);
        if (existing) {
          skippedExisting++;
          continue;
        }

        const sections = buildSections(subtype);
        await db.transaction(async (tx) => {
          const [questionnaire] = await tx
            .insert(caseTypeQuestionnaires)
            .values({
              caseTypeId: match.id,
              title: `${match.name} Intake Questionnaire`,
              description: `Intake questions for ${subtype.name}.`,
            })
            .returning();

          for (const [i, section] of sections.entries()) {
            const [s] = await tx
              .insert(caseTypeQuestionnaireSections)
              .values({
                questionnaireId: questionnaire.id,
                title: section.title,
                orderIndex: i,
              })
              .returning();

            for (const [j, q] of section.questions.entries()) {
              await tx.insert(caseTypeQuestionnaireQuestions).values({
                questionnaireId: questionnaire.id,
                sectionId: s.id,
                label: q.label,
                type: q.type,
                orderIndex: j,
                isRequired: q.isRequired,
              });
            }
          }
        });
        created++;
        console.log(`  ✓ ${match.name}`);
      }
    }
  }

  console.log(
    `\nMaster questionnaires: ${created} created, ${skippedExisting} skipped (already exist).`,
  );
  if (unmatched.length) {
    console.log(`Unmatched subtypes (no DB case type) — skipped:`);
    for (const u of unmatched) console.log(`  - ${u}`);
  }

  return { created, skippedExisting, unmatched };
}
