import { pgTable, uuid, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { permissionRoleEnum, permissionLevelEnum } from './module-permissions';
import { firms } from './firm-info';

export const accountTypeEnum = pgEnum('account_type', ['operating', 'trust_iolta']);

export const financialAccessControls = pgTable(
  'financial_access_controls',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    firmId:      uuid('firm_id').notNull().references(() => firms.id),
    accountType: accountTypeEnum('account_type').notNull(),
    role:        permissionRoleEnum('role').notNull(),
    permission:  permissionLevelEnum('permission').notNull(),
    updatedAt:   timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [unique().on(t.firmId, t.accountType, t.role)]
);

export type FinancialAccessControl = typeof financialAccessControls.$inferSelect;
export type NewFinancialAccessControl = typeof financialAccessControls.$inferInsert;
