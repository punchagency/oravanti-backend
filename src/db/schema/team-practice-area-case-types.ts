import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { team } from "./auth-schema";
import { practiceAreaCaseTypes } from "./practice-area-case-types";

export const teamPracticeAreaCaseTypes = pgTable(
  "team_practice_area_case_types",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.caseTypeId] })],
);

export type TeamPracticeAreaCaseType =
  typeof teamPracticeAreaCaseTypes.$inferSelect;
export type NewTeamPracticeAreaCaseType =
  typeof teamPracticeAreaCaseTypes.$inferInsert;
