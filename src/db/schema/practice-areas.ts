import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { firms } from "./firm-info";

export const practiceAreas = pgTable(
  "practice_areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firms.id),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("practice_areas_firm_name_unique").on(t.firmId, t.name)],
);

export type PracticeArea = typeof practiceAreas.$inferSelect;
export type NewPracticeArea = typeof practiceAreas.$inferInsert;
