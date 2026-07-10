import {
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { cases } from './cases';
import { practiceAreas } from './practice-areas';
import { practiceAreaCaseTypes } from './practice-area-case-types';
import { staff } from './staff';

// ─── Enums ──────────────────────────────────────────────────────────────────────

export const workflowStepStatusEnum = pgEnum('workflow_step_status', [
  'pending',
  'in_progress',
  'in_review',
  'completed',
  'skipped',
]);

export const noteCategoryEnum = pgEnum('note_category', [
  'client_communication',
  'internal_strategy',
  'medical_update',
  'intake_screening',
  'ops_review_feedback',
]);

export const noteVisibilityEnum = pgEnum('note_visibility', [
  'all_staff',
  'attorneys_only',
  'admins_only',
]);

export const moduleActivationTypeEnum = pgEnum('module_activation_type', [
  'auto',
  'conditional',
  'manual',
]);

// ─── Workflow Templates (The Blueprints) ─────────────────────────────────────────

export const workflowTemplates = pgTable('workflow_templates', {
  id:             uuid('id').primaryKey().defaultRandom(),
  practiceAreaId: uuid('practice_area_id').notNull().unique().references(() => practiceAreas.id),
  name:           text('name').notNull(),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
});

// ─── Workflow Modules ────────────────────────────────────────────────────────────

export const workflowModules = pgTable('workflow_modules', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  templateId:          uuid('template_id').notNull().references(() => workflowTemplates.id, { onDelete: 'cascade' }),
  name:                text('name').notNull(),
  description:         text('description'),
  phase:               text('phase').notNull().default('General'),
  activationType:      moduleActivationTypeEnum('activation_type').notNull().default('auto'),
  activationCondition: text('activation_condition'),
  orderIndex:          integer('order_index').notNull(),
  createdAt:           timestamp('created_at').notNull().defaultNow(),
});

// ─── Workflow Template Steps ─────────────────────────────────────────────────────

export const workflowTemplateSteps = pgTable('workflow_template_steps', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  moduleId:              uuid('module_id').notNull().references(() => workflowModules.id, { onDelete: 'cascade' }),
  title:                 text('title').notNull(),
  description:           text('description'),
  orderIndex:            integer('order_index').notNull(),
  dueInDays:             integer('due_in_days'),
  isRequired:            boolean('is_required').notNull().default(true),
  requiredCertification: text('required_certification'),
  createdAt:             timestamp('created_at').notNull().defaultNow(),
});

// ─── Case Workflow Steps (Live Execution) ────────────────────────────────────────

export const caseWorkflowSteps = pgTable('case_workflow_steps', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  organizationId:     text('organization_id').notNull().references(() => organization.id),
  caseId:             uuid('case_id').notNull().references(() => cases.id),
  templateStepId:     uuid('template_step_id').references(() => workflowTemplateSteps.id),
  title:              text('title').notNull(),
  description:        text('description'),
  orderIndex:         integer('order_index').notNull(),
  dueDate:            date('due_date'),
  status:             workflowStepStatusEnum('status').notNull().default('pending'),
  assignedToId:       uuid('assigned_to_id').references(() => staff.id),
  assignedAt:         timestamp('assigned_at'),
  completedById:      uuid('completed_by_id').references(() => staff.id),
  completedAt:        timestamp('completed_at'),
  timeTakenMs:        integer('time_taken_ms'),
  overrideRationale:  text('override_rationale'),
  overrideById:       uuid('override_by_id').references(() => staff.id),
  overrideAt:         timestamp('override_at'),
  notes:              text('notes'),
  createdAt:          timestamp('created_at').notNull().defaultNow(),
  updatedAt:          timestamp('updated_at').notNull().defaultNow(),
});

// ─── Case Notes (Decoupled from step lifecycle) ─────────────────────────────────

export const caseNotes = pgTable('case_notes', {
  id:                uuid('id').primaryKey().defaultRandom(),
  caseId:            uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
  workflowModuleId:  uuid('workflow_module_id').references(() => workflowModules.id, { onDelete: 'set null' }),
  taskId:            uuid('task_id').references(() => caseWorkflowSteps.id, { onDelete: 'set null' }),
  category:          noteCategoryEnum('category').notNull().default('internal_strategy'),
  visibility:        noteVisibilityEnum('visibility').notNull().default('all_staff'),
  content:           text('content').notNull(),
  isEdited:          boolean('is_edited').notNull().default(false),
  createdByUserId:   uuid('created_by_user_id').notNull(),
  createdAt:         timestamp('created_at', { precision: 6, withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { precision: 6, withTimezone: true }).notNull().defaultNow(),
});

// ─── Case Timeline Events ───────────────────────────────────────────────────────

export const caseTimelineEvents = pgTable('case_timeline_events', {
  id:          uuid('id').primaryKey().defaultRandom(),
  caseId:      uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
  eventType:   text('event_type').notNull(),
  title:       text('title').notNull(),
  description: text('description'),
  metadata:    jsonb('metadata'),
  createdById: uuid('created_by_id').references(() => staff.id),
  createdAt:   timestamp('created_at').notNull().defaultNow(),
});

// ─── Workflow Log (Audit Trail) ──────────────────────────────────────────────────

export const workflowLog = pgTable('workflow_log', {
  id:             uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  caseId:         uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
  stepId:         uuid('step_id').references(() => caseWorkflowSteps.id),
  moduleId:       uuid('module_id').references(() => workflowModules.id),
  eventType:      text('event_type').notNull(),
  title:          text('title').notNull(),
  description:    text('description'),
  metadata:       jsonb('metadata'),
  performedById:  uuid('performed_by_id').references(() => staff.id),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
});

// ─── Types ───────────────────────────────────────────────────────────────────────

export type WorkflowTemplate      = typeof workflowTemplates.$inferSelect;
export type WorkflowModule        = typeof workflowModules.$inferSelect;
export type WorkflowTemplateStep  = typeof workflowTemplateSteps.$inferSelect;
export type CaseWorkflowStep      = typeof caseWorkflowSteps.$inferSelect;
export type CaseNote              = typeof caseNotes.$inferSelect;
export type CaseTimelineEvent     = typeof caseTimelineEvents.$inferSelect;
export type WorkflowLogEntry      = typeof workflowLog.$inferSelect;
