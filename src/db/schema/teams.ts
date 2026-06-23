import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { staff } from "./staff";

export const teamStatusEnum = pgEnum("team_status", [
  "available",
  "full",
  "overloaded",
]);

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    name: text("name").notNull(),
    leadId: uuid("lead_id").references(() => staff.id),
    description: text("description"),
    maxCaseload: integer("max_caseload").notNull().default(50),
    workloadPercentage: integer("workload_percentage").notNull().default(0),
    status: teamStatusEnum("status").notNull().default("available"),
    activeCases: integer("active_cases").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.name)],
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
