import { pgTable, uuid, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';
import { cases } from './cases';

export const adversePartyRelationshipEnum = pgEnum('adverse_party_relationship', [
  'opposing_party',
  'opposing_counsel',
  'witness',
  'other',
]);

export const adversePartyEntityTypeEnum = pgEnum('adverse_party_entity_type', [
  'individual',
  'company',
]);

export const adverseParties = pgTable('adverse_parties', {
  id:             uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  caseId:         uuid('case_id').notNull().references(() => cases.id, { onDelete: "cascade" }),
  name:           text('name').notNull(),
  email:          text('email'),
  entityType:     adversePartyEntityTypeEnum('entity_type').notNull().default('individual'),
  relationship:   adversePartyRelationshipEnum('relationship').notNull(),
  notes:          text('notes'),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
});

export type AdverseParty    = typeof adverseParties.$inferSelect;
export type NewAdverseParty = typeof adverseParties.$inferInsert;
