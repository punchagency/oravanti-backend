import { pgTable, uuid, text, timestamp, pgEnum, jsonb } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { leads } from './leads';
import { staff } from './staff';

export const conflictCheckStatusEnum = pgEnum('conflict_check_status', [
  'pending',
  'pass',
  'needs_review',
  'conflict_found',
]);

export const conflictChecks = pgTable('conflict_checks', {
  id:             uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  leadId:         uuid('lead_id').notNull().references(() => leads.id),
  status:         conflictCheckStatusEnum('status').notNull().default('pending'),
  /**
   * Array of match objects:
   * { type, matchedId, matchedName, confidence, rule, details }
   */
  matches:        jsonb('matches').notNull().default([]),
  checkedById:    uuid('checked_by_id').references(() => staff.id),
  checkedAt:      timestamp('checked_at'),
  reviewedById:   uuid('reviewed_by_id').references(() => staff.id),
  reviewedAt:     timestamp('reviewed_at'),
  reviewNotes:    text('review_notes'),
  supervisorOverrideById:    uuid('supervisor_override_by_id').references(() => staff.id),
  supervisorOverrideAt:      timestamp('supervisor_override_at'),
  supervisorOverrideNotes:   text('supervisor_override_notes'),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
});

export type ConflictCheck    = typeof conflictChecks.$inferSelect;
export type NewConflictCheck = typeof conflictChecks.$inferInsert;
