import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { staff } from "./staff";

/**
 * Which task table `taskId` points at.
 *
 * Intake tasks (`lead_tasks`) and case workflow steps (`case_workflow_steps`)
 * run the same submit → review → approve/reject loop, so their review threads
 * live in one table and render through one component. The reference is
 * deliberately polymorphic — a real FK per kind would mean two nullable columns
 * and a check constraint for no gain, since nothing joins from here.
 */
export const taskReviewKindEnum = pgEnum("task_review_kind", [
  "lead_task",
  "case_step",
]);

export const taskReviewActionEnum = pgEnum("task_review_action", [
  "submitted",
  "approved",
  "rejected",
  "reopened",
  "assigned",
]);

/**
 * Append-only trail of everything said while a task moved through review.
 *
 * Both task tables carry a single `notes` text column that every stage of the
 * loop used to overwrite: the assignee's submission note, then the reviewer's
 * approval note, then the rejection feedback — each one destroying the last.
 * Rows here are never updated, so the full exchange stays readable afterwards.
 */
export const taskReviewEvents = pgTable(
  "task_review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    taskKind: taskReviewKindEnum("task_kind").notNull(),
    /** `lead_tasks.id` or `case_workflow_steps.id`, per `taskKind`. */
    taskId: uuid("task_id").notNull(),
    /**
     * The lead or case the task hangs off. Denormalised so the review thread
     * can be authorised and listed without joining back to the task itself.
     */
    leadId: uuid("lead_id"),
    caseId: uuid("case_id"),
    action: taskReviewActionEnum("action").notNull(),
    note: text("note"),
    actorId: uuid("actor_id").references(() => staff.id),
    /** Snapshotted so a later rename or deletion can't blank out the trail. */
    actorName: text("actor_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("task_review_events_task_idx").on(table.taskKind, table.taskId),
    index("task_review_events_org_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export type TaskReviewEvent = typeof taskReviewEvents.$inferSelect;
export type NewTaskReviewEvent = typeof taskReviewEvents.$inferInsert;
export type TaskReviewKind = (typeof taskReviewKindEnum.enumValues)[number];
export type TaskReviewAction = (typeof taskReviewActionEnum.enumValues)[number];
