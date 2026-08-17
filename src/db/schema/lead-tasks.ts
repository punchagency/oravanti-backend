import {
  boolean,
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { leadPipelineStageEnum } from "./leads";
import { leads } from "./leads";
import { staff } from "./staff";

export const leadTaskStatusEnum = pgEnum("lead_task_status", [
  "pending",
  "in_progress",
  "in_review",
  "completed",
  "skipped",
  // A rejected review used to drop the task back to `in_progress`, which told
  // the assignee nothing. `rejected` is terminal until they reopen it, so it
  // can be surfaced as its own state and filtered into its own tab.
  "rejected",
]);

export const leadTasks = pgTable("lead_tasks", {
  id:             uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id").notNull().references(() => organization.id),
  leadId:         uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  title:          text("title").notNull(),
  description:    text("description"),
  orderIndex:     integer("order_index").notNull(),
  pipelineStage:  leadPipelineStageEnum("pipeline_stage").notNull(),
  isRequired:     boolean("is_required").notNull().default(true),
  status:         leadTaskStatusEnum("status").notNull().default("pending"),
  assignedToId:   uuid("assigned_to_id").references(() => staff.id),
  assignedAt:     timestamp("assigned_at"),
  completedById:  uuid("completed_by_id").references(() => staff.id),
  completedAt:    timestamp("completed_at"),
  dueDate:        date("due_date"),
  notes:          text("notes"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
});

export type LeadTask = typeof leadTasks.$inferSelect;
export type NewLeadTask = typeof leadTasks.$inferInsert;
