import { pgTable, uuid, text, date, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { clients } from './clients';
import { cases } from './cases';
import { firms } from './firm-info';

export const clientRequestStatusEnum = pgEnum('client_request_status', ['pending', 'fulfilled']);

export const clientRequests = pgTable('client_requests', {
  id:          uuid('id').primaryKey().defaultRandom(),
  firmId:      uuid('firm_id').notNull().references(() => firms.id),
  clientId:    uuid('client_id').notNull().references(() => clients.id, { onDelete: 'cascade' }),
  caseId:      uuid('case_id').notNull().references(() => cases.id),
  description: text('description').notNull(),
  requestedAt: date('requested_at').notNull(),
  status:      clientRequestStatusEnum('status').notNull().default('pending'),
  createdAt:   timestamp('created_at').notNull().defaultNow(),
  updatedAt:   timestamp('updated_at').notNull().defaultNow(),
});

export type ClientRequest = typeof clientRequests.$inferSelect;
export type NewClientRequest = typeof clientRequests.$inferInsert;
