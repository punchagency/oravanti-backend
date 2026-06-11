import { pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { practiceAreas } from "./practice-areas";

export const practiceAreaSubcategories = pgTable(
  "practice_area_subcategories",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    practiceAreaId: uuid("practice_area_id")
      .references(() => practiceAreas.id, { onDelete: "cascade" })
      .notNull(),

    code: varchar("code", { length: 120 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("practice_area_subcategories_practice_area_code_unique").on(
      table.practiceAreaId,
      table.code,
    ),
  ],
);

export type PracticeAreaSubcategory =
  typeof practiceAreaSubcategories.$inferSelect;
export type NewPracticeAreaSubcategory =
  typeof practiceAreaSubcategories.$inferInsert;
