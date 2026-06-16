import { pgTable, uuid, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { organization } from './auth-schema';

export const clientEntityTypeEnum = pgEnum('client_entity_type', [
  'individual',
  'company',
  'trust',
  'estate',
  'other',
]);

export const clientStatusEnum = pgEnum('client_status', ['active', 'inactive', 'pending']);

export const clients = pgTable('clients', {
  id:             uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull().references(() => organization.id),
  entityType:     clientEntityTypeEnum('entity_type').notNull().default('individual'),
  displayName:    text('display_name').notNull(),
  status:         clientStatusEnum('status').notNull().default('active'),
  createdAt:      timestamp('created_at').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
});

export type Client    = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
