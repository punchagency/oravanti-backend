import {
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { admins } from "./admins";
import { organization, team } from "./auth-schema";
import { cases } from "./cases";
import { staff } from "./staff";

export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);
export const taskPriorityEnum = pgEnum("task_priority", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  title: text("title").notNull(),
  description: text("description").notNull(),
  caseId: uuid("case_id")
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  teamId: text("team_id").references(() => team.id),
  assignedToId: uuid("assigned_to_id")
    .notNull()
    .references(() => staff.id),
  assignedById: uuid("assigned_by_id")
    .notNull()
    .references(() => admins.id),
  dueDate: date("due_date").notNull(),
  priority: taskPriorityEnum("priority").notNull().default("medium"),
  status: taskStatusEnum("status").notNull().default("pending"),
  progress: integer("progress").notNull().default(0),
  requiredCertifications: text("required_certifications")
    .array()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
