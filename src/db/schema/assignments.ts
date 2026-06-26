import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization, team } from "./auth-schema";
import { cases } from "./cases";
import { contractors } from "./contractors";
import {
  assignmentStatusEnum,
  assignmentTypeEnum,
  filingTypeEnum,
  urgencyLevelEnum,
} from "./enums";
import { staff } from "./staff";

export const assignments = pgTable("assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  caseId: uuid("case_id").references(() => cases.id),
  assignmentType: assignmentTypeEnum("assignment_type").notNull(),
  filingType: filingTypeEnum("filing_type").notNull(),
  urgencyLevel: urgencyLevelEnum("urgency_level").notNull().default("normal"),
  status: assignmentStatusEnum("status").notNull().default("pending"),
  teamId: text("team_id").references(() => team.id),
  assignedStaffId: uuid("assigned_staff_id").references(() => staff.id),
  contractorId: uuid("contractor_id").references(() => contractors.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
