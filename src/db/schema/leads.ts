import { pgTable, uuid, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { practiceAreas } from './practice-areas';
import { practiceAreaCaseTypes } from './practice-area-case-types';
import { staff } from './staff';

export const leadEntityTypeEnum = pgEnum('lead_entity_type', ['individual', 'company']);

export const leadSourceEnum = pgEnum('lead_source', [
  'education_flywheel',
  'referral',
  'direct',
  'walk_in',
  'phone_enquiry',
  'client_portal',
]);

export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'reviewed',
  'archived',
  'declined',   // terminal: lead terminated for a conflict
  'overridden', // proceeded despite a found conflict (cleared by reviewer)
]);

export const leadPipelineStageEnum = pgEnum('lead_pipeline_stage', [
  'lead_inbox',
  'conflict_check',
  'questionnaire',
  'consultation',
  'fee_agreement',
  'case_opening',
]);

export const leads = pgTable('leads', {
  id:             uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  name:           text('name').notNull(),
  email:          text('email').notNull(),
  phone:          text('phone'),
  entityType:     leadEntityTypeEnum('entity_type').notNull().default('individual'),
  practiceAreaId: uuid('practice_area_id').references(() => practiceAreas.id),
  caseTypeId:     uuid('case_type_id').references(() => practiceAreaCaseTypes.id),
  source:         leadSourceEnum('source').notNull(),
  situationSummary: text('situation_summary'),
  notes:            text('notes'),
  intakeAdversePartyName:  text('intake_adverse_party_name'),
  intakeAdversePartyEmail: text('intake_adverse_party_email'),
  status:         leadStatusEnum('status').notNull().default('new'),
  pipelineStage:  leadPipelineStageEnum('pipeline_stage').notNull().default('lead_inbox'),

  // Stage-linked IDs — plain uuid, no FK (avoids circular deps with pipeline tables)
  conflictCheckId:     uuid('conflict_check_id'),
  questionnaireSendId: uuid('questionnaire_send_id'),
  consultationId:      uuid('consultation_id'),
  feeAgreementId:      uuid('fee_agreement_id'),

  // Populated on case opening
  convertedClientId: uuid('converted_client_id'),
  convertedCaseId:   uuid('converted_case_id'),
  convertedAt:       timestamp('converted_at'),

  assignedStaffId: uuid('assigned_staff_id').references(() => staff.id),
  receivedAt:      timestamp('received_at').notNull().defaultNow(),
  createdAt:       timestamp('created_at').notNull().defaultNow(),
  updatedAt:       timestamp('updated_at').notNull().defaultNow(),
});

export type Lead    = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
