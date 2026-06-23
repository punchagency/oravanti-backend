import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { team } from "./auth-schema";
import { practiceAreas } from "./practice-areas";

export const teamPracticeAreas = pgTable(
  "team_practice_areas",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    practiceAreaId: uuid("practice_area_id")
      .notNull()
      .references(() => practiceAreas.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.practiceAreaId] })],
);

export type TeamPracticeArea = typeof teamPracticeAreas.$inferSelect;
export type NewTeamPracticeArea = typeof teamPracticeAreas.$inferInsert;
