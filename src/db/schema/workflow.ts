import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { cases } from './cases';
import { dateAnchorEnum } from './document-requirements';
import { practiceAreaCaseTypes } from './practice-area-case-types';
import { tasks } from './tasks';

// ─── Enums ──────────────────────────────────────────────────────────────────────

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

export const caseNoteContextEnum = pgEnum('case_note_context', [
  'notes_tab',
  'workflow_step',
  'task',
  'lead_conversion',
  'system',
]);

export const moduleActivationTypeEnum = pgEnum('module_activation_type', [
  'auto',
  'conditional',
  'manual',
]);

// ─── Module activation condition ────────────────────────────────────────────────
//
// A small hand-rolled shape, not a general rules DSL — deliberately not
// open-ended (no arbitrary-path JSON querying). Extending `ConditionField` is
// how a future practice area adds its own branch point. See
// `.claude/workflows/01-data-model.md §4` for the full rationale, and
// `condition-evaluator.ts` (src/modules/workflow) for the interpreter.
export type ConditionField =
  | 'immigrationDetails.filingTrack'
  | 'immigrationDetails.naturalizationTrack'
  | 'immigrationDetails.isConditionalResidence'
  | 'immigrationDetails.priorityDateIsCurrent'
  | 'personalInjuryDetails.defendantType'
  | 'personalInjuryDetails.isMinorPlaintiff'
  | 'case.priority';

export type Condition =
  | { field: ConditionField; op: 'eq' | 'neq'; value: string | boolean }
  | { field: ConditionField; op: 'in'; value: string[] }
  | { allOf: Condition[] }
  | { anyOf: Condition[] };

// ─── Workflow Templates (The Blueprints) ─────────────────────────────────────────

/**
 * Keyed on `caseTypeId` (the practice-area-taxonomy leaf), not `practiceAreaId` —
 * lets a firm have a different template per case type instead of one global
 * template per practice area. `organizationId` null = system default shipped by
 * Oravanti; non-null = one firm's own copy (cloned on their first edit to a
 * locked system default — see workflow-template.service.ts). No uniqueness
 * constraint on (organizationId, caseTypeId): resolution picks the newest
 * `isActive` row for the scope, mirroring `intake_pipeline_templates`, so
 * publishing a revision is a plain insert rather than an in-place edit.
 */
export const workflowTemplates = pgTable(
  'workflow_templates',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').references(() => organization.id),
    caseTypeId:     uuid('case_type_id').notNull().references(() => practiceAreaCaseTypes.id, { onDelete: 'cascade' }),
    name:           text('name').notNull(),
    isActive:       boolean('is_active').notNull().default(true),
    createdAt:      timestamp('created_at').notNull().defaultNow(),
    updatedAt:      timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('wt_organization_idx').on(table.organizationId),
    index('wt_case_type_idx').on(table.caseTypeId),
  ],
);

// ─── Workflow Modules ────────────────────────────────────────────────────────────

export const workflowModules = pgTable('workflow_modules', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  templateId:          uuid('template_id').notNull().references(() => workflowTemplates.id, { onDelete: 'cascade' }),
  name:                text('name').notNull(),
  description:         text('description'),
  phase:               text('phase').notNull().default('General'),
  activationType:      moduleActivationTypeEnum('activation_type').notNull().default('auto'),
  /** Only meaningful when `activationType = 'conditional'`. Validated against the `ConditionField` union at template-save time, not just at evaluation time. */
  activationCondition: jsonb('activation_condition').$type<Condition>(),
  orderIndex:          integer('order_index').notNull(),
  createdAt:           timestamp('created_at').notNull().defaultNow(),
});

// ─── Workflow Template Steps ─────────────────────────────────────────────────────

export const workflowTemplateSteps = pgTable('workflow_template_steps', {
  id:                      uuid('id').primaryKey().defaultRandom(),
  moduleId:                uuid('module_id').notNull().references(() => workflowModules.id, { onDelete: 'cascade' }),
  title:                   text('title').notNull(),
  description:             text('description'),

  /**
   * ─── Staff-facing guidance ────────────────────────────────────────────────
   *
   * A step title tells someone *what* to do; on a matter with statutory
   * consequences that is not enough to act on. These five carry the context a
   * paralegal would otherwise have to go and ask an attorney for, and every one
   * of them is copied onto the task at materialization (see
   * `task-materialization.service.ts`) so the person holding the work reads the
   * same thing the template author wrote.
   *
   * Split into five columns rather than one prose blob so the UI can label and
   * order them identically on every task — a reader learns one shape and then
   * knows where to look. Each is independently nullable: a step with nothing
   * worth saying under a heading renders no heading at all, which is better
   * than a heading over filler.
   */

  /** Why this step exists — the consequence of skipping it. One or two sentences. */
  purpose:                 text('purpose'),
  /** Ordered, imperative bullets: how to actually carry the step out. */
  guidance:                text('guidance').array().notNull().default([]),
  /** The completion test, in observable terms — what makes this genuinely done. */
  doneWhen:                text('done_when'),
  /** The specific way this step is commonly got wrong, and its cost. */
  pitfalls:                text('pitfalls'),
  /** Statute, regulation, or form instruction the step traces to. Never invented. */
  authority:               text('authority'),

  orderIndex:              integer('order_index').notNull(),

  // due-date-anchor pattern, shared with `caseTypeDocumentRequirements` — see
  // `dateAnchorEnum` (document-requirements.ts) and `resolveDueDate` (workflow module).
  dueDateAnchor:           dateAnchorEnum('due_date_anchor'),
  dueDateOffsetDays:       integer('due_date_offset_days'), // signed: negative = before anchor

  isRequired:              boolean('is_required').notNull().default(true),
  /**
   * Locked-backbone-plus-firm-add-ons: a firm's own cloned template cannot
   * delete or weaken a locked step's anchor/offset/certifications without an
   * explicit override + rationale at the per-task level (`tasks.overrideRationale`,
   * not here — this flag lives on the template so every task materialized from
   * it inherits it).
   */
  isLocked:                boolean('is_locked').notNull().default(false),

  requiredCertifications:  text('required_certifications').array().notNull().default([]),
  /** Dynamic RBAC role names (`organization_role.role`), not a hardcoded enum. */
  assignableRoles:         text('assignable_roles').array().notNull().default([]),

  createdAt:               timestamp('created_at').notNull().defaultNow(),
  updatedAt:               timestamp('updated_at').notNull().defaultNow(),
});

// ─── Case Notes (Decoupled from step lifecycle) ─────────────────────────────────

export const caseNotes = pgTable('case_notes', {
  id:                uuid('id').primaryKey().defaultRandom(),
  organizationId:    text('organization_id').notNull().references(() => organization.id),
  caseId:            uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
  workflowModuleId:  uuid('workflow_module_id').references(() => workflowModules.id, { onDelete: 'set null' }),
  taskId:            uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  category:          noteCategoryEnum('category').notNull().default('internal_strategy'),
  visibility:        noteVisibilityEnum('visibility').notNull().default('all_staff'),
  isPinned:          boolean('is_pinned').notNull().default(false),
  context:           caseNoteContextEnum('context').notNull().default('notes_tab'),
  content:           text('content').notNull(),
  isEdited:          boolean('is_edited').notNull().default(false),
  createdByUserId:   uuid('created_by_user_id').notNull(),
  createdAt:         timestamp('created_at', { precision: 6, withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { precision: 6, withTimezone: true }).notNull().defaultNow(),
});

// ─── Module activation stamps ────────────────────────────────────────────────────

/**
 * When a module first became active on one matter.
 *
 * Exists to back the `module_activated` due-date anchor, and it is the fix for
 * a real defect: every step in the AOS package modules was anchored on
 * `case_opened`. On a concurrent filing that is right — the package is
 * assembled from day one. On a *sequential* filing the same module does not
 * open until the priority date becomes current, which can be years later, and
 * the steps then materialized with due dates measured from case opening — instantly
 * years overdue, firing an overdue alert for every step the moment the work
 * legitimately became available.
 *
 * A conditional module's deadlines run from when the work actually became
 * possible, not from when the matter opened. That date is not derivable after
 * the fact, so it is recorded here at the moment materialization first writes
 * the module's steps.
 *
 * Written once per case+module and never updated: a module withdrawn on
 * retrogression and later restored keeps its original activation, because the
 * tasks it restores are the same tasks with the same deadlines. Deleting the
 * row instead would silently re-date live work.
 */
export const workflowModuleActivations = pgTable(
  'workflow_module_activations',
  {
    id:             uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull().references(() => organization.id),
    caseId:         uuid('case_id').notNull().references(() => cases.id, { onDelete: 'cascade' }),
    moduleId:       uuid('module_id').notNull().references(() => workflowModules.id, { onDelete: 'cascade' }),
    activatedAt:    timestamp('activated_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wma_case_module_unique').on(table.caseId, table.moduleId),
    index('wma_case_idx').on(table.caseId),
  ],
);

// ─── Types ───────────────────────────────────────────────────────────────────────

export type WorkflowTemplate      = typeof workflowTemplates.$inferSelect;
export type WorkflowModule        = typeof workflowModules.$inferSelect;
export type WorkflowTemplateStep  = typeof workflowTemplateSteps.$inferSelect;
export type CaseNote              = typeof caseNotes.$inferSelect;
