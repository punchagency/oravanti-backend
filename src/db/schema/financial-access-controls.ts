import { pgTable, uuid, text, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { permissionRoleEnum, permissionLevelEnum } from './module-permissions';
import { organization } from './auth-schema';

export const accountTypeEnum = pgEnum('account_type', ['operating', 'trust_iolta']);

export const financialAccessControls = pgTable(
  'financial_access_controls',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    organizationId:      text('organization_id').notNull().references(() => organization.id),
    accountType: accountTypeEnum('account_type').notNull(),
    role:        permissionRoleEnum('role').notNull(),
    permission:  permissionLevelEnum('permission').notNull(),
    updatedAt:   timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.organizationId, t.accountType, t.role)]
);

export type FinancialAccessControl = typeof financialAccessControls.$inferSelect;
export type NewFinancialAccessControl = typeof financialAccessControls.$inferInsert;
