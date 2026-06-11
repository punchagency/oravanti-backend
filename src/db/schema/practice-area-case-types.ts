import { pgEnum, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { practiceAreaSubcategories } from "./practice-area-subcategories";

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
