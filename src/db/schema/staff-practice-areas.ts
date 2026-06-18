import { pgTable, uuid, primaryKey } from "drizzle-orm/pg-core";
import { staff } from "./staff";
import { practiceAreas } from "./practice-areas";

export const staffPracticeAreas = pgTable(
  "staff_practice_areas",
  {
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    practiceAreaId: uuid("practice_area_id")
      .notNull()
      .references(() => practiceAreas.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.practiceAreaId] })],
);

export type StaffPracticeArea = typeof staffPracticeAreas.$inferSelect;
export type NewStaffPracticeArea = typeof staffPracticeAreas.$inferInsert;
