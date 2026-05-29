import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";

export const practiceAreas = pgTable("practice_areas", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type PracticeArea = typeof practiceAreas.$inferSelect;
export type NewPracticeArea = typeof practiceAreas.$inferInsert;
