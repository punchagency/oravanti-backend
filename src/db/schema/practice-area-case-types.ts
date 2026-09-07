import { pgEnum, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { practiceAreaSubcategories } from "./practice-area-subcategories";
import { taxonomyStatusEnum } from "./taxonomy-status";

export const caseTypeJurisdictionEnum = pgEnum("case_type_jurisdiction", [
  "federal",
  "state",
  "federal & state",
  "varies",
]);

export const practiceAreaCaseTypes = pgTable(
  "practice_area_case_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    subcategoryId: uuid("subcategory_id")
      .references(() => practiceAreaSubcategories.id, { onDelete: "cascade" })
      .notNull(),

    code: varchar("code", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    caseNumberPrefix: varchar("case_number_prefix", { length: 20 }).notNull(),
    jurisdiction: caseTypeJurisdictionEnum("jurisdiction").notNull(),

    /**
     * What this kind of matter is, for its own page in the CRM.
     *
     * The leaf is where the taxonomy stops being abstract — it is what files
     * forms and asks a questionnaire — so this is the description that earns
     * its keep. "I-485 — Adjustment of Status (Family-Based)" is a name; what
     * an operator needs before wiring a package to it is the paragraph.
     */
    description: text("description"),

    status: taxonomyStatusEnum("status").notNull().default("active"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("practice_area_case_types_subcategory_code_unique").on(
      table.subcategoryId,
      table.code,
    ),
  ],
);

export type PracticeAreaCaseType = typeof practiceAreaCaseTypes.$inferSelect;
export type NewPracticeAreaCaseType = typeof practiceAreaCaseTypes.$inferInsert;
export type CaseTypeJurisdiction =
  (typeof caseTypeJurisdictionEnum.enumValues)[number];
