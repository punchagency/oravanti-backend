import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { leadPipelineStageEnum } from "./leads";

/**
 * The blueprint `initializePipelineSteps` stamps onto every new lead.
 *
 * These steps used to be a hardcoded array in the workflow service, which meant
 * changing a firm's intake checklist was a deploy. They live here instead, in
 * the same template → steps shape the case workflow already uses
 * (`workflow_templates` → `workflow_template_steps`).
 *
 * A row with a null `organizationId` is the system default, used by any firm
 * that has not defined its own. Seeded by `intake-pipeline.seed.ts`.
 *
 * Uniqueness of the active template per firm is not enforced by an index:
 * Postgres treats NULLs as distinct, so it would not constrain the system
 * default anyway. `resolveIntakePipelineTemplate` picks the newest active row
 * instead, which also makes "publish a new version" a plain insert.
 */
export const intakePipelineTemplates = pgTable(
  "intake_pipeline_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null marks the system-wide default template. */
    organizationId: text("organization_id").references(() => organization.id),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("intake_pipeline_templates_org_idx").on(
      table.organizationId,
      table.isActive,
    ),
  ],
);

export const intakePipelineTemplateSteps = pgTable(
  "intake_pipeline_template_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => intakePipelineTemplates.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    pipelineStage: leadPipelineStageEnum("pipeline_stage").notNull(),
    /** Position within the stage, matching `lead_tasks.order_index`. */
    orderIndex: integer("order_index").notNull(),
    isRequired: boolean("is_required").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("intake_pipeline_template_steps_template_idx").on(
      table.templateId,
      table.pipelineStage,
      table.orderIndex,
    ),
  ],
);

export type IntakePipelineTemplate =
  typeof intakePipelineTemplates.$inferSelect;
export type IntakePipelineTemplateStep =
  typeof intakePipelineTemplateSteps.$inferSelect;
