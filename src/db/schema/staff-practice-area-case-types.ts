import { pgTable, uuid, primaryKey } from "drizzle-orm/pg-core";
import { staff } from "./staff";
import { practiceAreaCaseTypes } from "./practice-area-case-types";

export const staffPracticeAreaCaseTypes = pgTable(
  "staff_practice_area_case_types",
  {
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.caseTypeId] })],
);

export type StaffPracticeAreaCaseType =
  typeof staffPracticeAreaCaseTypes.$inferSelect;
export type NewStaffPracticeAreaCaseType =
  typeof staffPracticeAreaCaseTypes.$inferInsert;
