import { pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { practiceAreas } from "./practice-areas";

export const practiceAreaCaseTypes = pgTable(
  "practice_area_case_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    practiceAreaId: uuid("practice_area_id")
      .references(() => practiceAreas.id, { onDelete: "cascade" })
      .notNull(),

    code: varchar("code", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    caseNumberPrefix: varchar("case_number_prefix", { length: 20 }).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("practice_area_case_types_practice_area_code_unique").on(
      table.practiceAreaId,
      table.code,
    ),
  ],
);

export type PracticeAreaCaseType = typeof practiceAreaCaseTypes.$inferSelect;
export type NewPracticeAreaCaseType = typeof practiceAreaCaseTypes.$inferInsert;
