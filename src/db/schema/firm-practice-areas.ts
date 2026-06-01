import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from './auth-schema';
import { practiceAreas } from "./practice-areas";

export const firmPracticeAreas = pgTable("firm_practice_areas", {
  id: uuid("id").primaryKey().defaultRandom(),

  organizationId: text("organization_id")
    .references(() => organization.id, { onDelete: "cascade" })
    .notNull(),

  practiceAreaId: uuid("practice_area_id")
    .references(() => practiceAreas.id, { onDelete: "cascade" })
    .notNull(),

  subscriptionId: uuid("subscription_id").notNull(),

  active: boolean("active").default(true).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type FirmPracticeArea = typeof firmPracticeAreas.$inferSelect;
export type NewFirmPracticeArea = typeof firmPracticeAreas.$inferInsert;
