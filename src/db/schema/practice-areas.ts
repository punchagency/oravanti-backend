import { pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

import { taxonomyStatusEnum } from "./taxonomy-status";

/**
 * The top of the practice taxonomy — Immigration Law, Personal Injury Law.
 *
 * Global reference data: one row per area, identical for every firm, and the
 * root of `practice_areas → practice_area_subcategories →
 * practice_area_case_types`. Maintained from the Oravanti CRM at `/platform`
 * behind `requirePlatformAdmin`; a firm chooses which of these it works in
 * (`firm_practice_areas`) but does not author them.
 */
export const practiceAreas = pgTable(
  "practice_areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),

    /**
     * What this area covers, in a paragraph, for the CRM's own page.
     *
     * Nullable because the eight seeded areas predate it and an empty
     * description is an honest "nobody has written this yet" rather than a
     * placeholder somebody has to notice is fake.
     */
    description: text("description"),

    status: taxonomyStatusEnum("status").notNull().default("active"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    /*
      One area per name. Without this the CRM's create button silently makes a
      second "Immigration Law", and from then on which one a firm subscribes to
      is a coin toss — the subcategories underneath are split across two rows
      that look identical in every list.
    */
    unique("practice_areas_name_unique").on(t.name),
  ],
);

export type PracticeArea = typeof practiceAreas.$inferSelect;
export type NewPracticeArea = typeof practiceAreas.$inferInsert;
