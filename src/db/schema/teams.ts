import { pgTable, uuid, text, integer, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { staff } from './staff';
import { firms } from './firm-info';

export const teamStatusEnum = pgEnum('team_status', ['available', 'full', 'overloaded']);

export const teams = pgTable(
  'teams',
  {
    id:                 uuid('id').primaryKey().defaultRandom(),
    firmId:             uuid('firm_id').notNull().references(() => firms.id),
    name:               text('name').notNull(),
    leadId:             uuid('lead_id').references(() => staff.id),
    description:        text('description'),
    maxCaseload:        integer('max_caseload').notNull().default(50),
    workloadPercentage: integer('workload_percentage').notNull().default(0),
    status:             teamStatusEnum('status').notNull().default('available'),
    activeCases:        integer('active_cases').notNull().default(0),
    createdAt:          timestamp('created_at').notNull().defaultNow(),
    updatedAt:          timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.firmId, t.name)]
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
