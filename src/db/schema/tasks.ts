import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, team } from "./auth-schema";
import { cases } from "./cases";
import { intakePipelineTemplateSteps } from "./intake-pipeline-templates";
import { leads } from "./leads";
import { staff } from "./staff";
import { workflowTemplateSteps } from "./workflow";

/**
 * Superset of the three tables this replaces (`tasks`, `lead_tasks`,
 * `case_workflow_steps`): the old generic `tasks` had
 * {pending,in_progress,completed,cancelled}; `lead_tasks`/`case_workflow_steps`
 * both had {pending,in_progress,in_review,completed,skipped,rejected}. Union of
 * both, verified 1:1 against the real enums at implementation time (not just
 * the earlier design doc's assumption).
 */
export const taskStatusEnum = pgEnum("task_status", [
  "pending",
  "in_progress",
  "in_review",
  "completed",
  "skipped",
  "rejected",
  "cancelled",
]);

export const taskPriorityEnum = pgEnum("task_priority", [
  "low",
  "medium",
  "high",
  "critical",
]);

/** Where a task originated. Determines which `*TemplateStepId` (if any) is set. */
export const taskSourceEnum = pgEnum("task_source", [
  "workflow",
  "pipeline",
  "ad_hoc",
]);

/**
 * Replaces `tasks`, `lead_tasks`, and `case_workflow_steps` — one task can
 * originate from a workflow template step, an intake pipeline template step, or
 * be created ad hoc; the shape is the same regardless of origin. See
 * `.claude/workflows/01-data-model.md §2` for the full design rationale and
 * `06-rollout-and-testing.md §2` for how existing rows in the three old tables
 * get migrated into this one.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),

    caseId: uuid("case_id").references(() => cases.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),

    source: taskSourceEnum("source").notNull(),
    // set only when source = 'workflow' / 'pipeline' respectively; both null for ad_hoc
    workflowTemplateStepId: uuid("workflow_template_step_id").references(
      () => workflowTemplateSteps.id,
    ),
    // `set null`, not the default `no action`: editing the intake checklist
    // replaces its steps wholesale, and without this the first firm to edit a
    // checklist that had ever stamped a lead got a foreign-key violation
    // instead of a saved template. A pipeline task copies its title, stage and
    // order at stamp time, so this column is provenance — losing it costs the
    // "which template step was this?" link and nothing a person reads.
    pipelineTemplateStepId: uuid("pipeline_template_step_id").references(
      () => intakePipelineTemplateSteps.id,
      { onDelete: "set null" },
    ),

    title: text("title").notNull(),
    description: text("description"),
    /** Denormalized snapshot of the owning module's `phase` at materialization time — the stable display grouping, unlike `moduleId` which is a template-time concept. */
    phase: text("phase"),
    orderIndex: integer("order_index"),
    isRequired: boolean("is_required").notNull().default(true),
    /** Snapshot from the template step at materialization time. */
    isLocked: boolean("is_locked").notNull().default(false),

    status: taskStatusEnum("status").notNull().default("pending"),
    priority: taskPriorityEnum("priority"),

    assignedToId: uuid("assigned_to_id").references(() => staff.id),
    // Old generic `tasks.assignedById` referenced `admins.id` — corrected to
    // `staff.id` during consolidation; every assignment path (workflow-materialized,
    // pipeline-materialized, ad hoc) is assigned BY a staff member.
    assignedById: uuid("assigned_by_id").references(() => staff.id),
    teamId: text("team_id").references(() => team.id),
    assignedAt: timestamp("assigned_at"),
    completedById: uuid("completed_by_id").references(() => staff.id),
    completedAt: timestamp("completed_at"),

    dueDate: date("due_date"),
    requiredCertifications: text("required_certifications")
      .array()
      .notNull()
      .default([]),

    // locked-task override trail (moved from case_workflow_steps, same shape)
    overrideRationale: text("override_rationale"),
    overrideById: uuid("override_by_id").references(() => staff.id),
    overrideAt: timestamp("override_at"),

    // reminder de-dup, read by the hourly deadline sweep — see notifications.ts
    reminder3dSentAt: timestamp("reminder_3d_sent_at"),
    reminder1dSentAt: timestamp("reminder_1d_sent_at"),
    overdueReminderSentAt: timestamp("overdue_reminder_sent_at"),

    timeTakenMs: integer("time_taken_ms"),
    notes: text("notes"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "tasks_exactly_one_scenario",
      sql`(${table.leadId} IS NOT NULL)::int + (${table.caseId} IS NOT NULL)::int = 1`,
    ),
    index("tasks_organization_idx").on(table.organizationId),
    index("tasks_case_idx").on(table.caseId),
    index("tasks_lead_idx").on(table.leadId),
    index("tasks_assigned_to_idx").on(table.assignedToId),
    index("tasks_status_idx").on(table.status),
    index("tasks_due_date_idx").on(table.dueDate), // read by the reminder sweep
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
