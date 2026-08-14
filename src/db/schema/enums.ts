import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * `portal_status` is declared outside this directory — re-exported so
 * drizzle-kit emits it.
 *
 * `drizzle.config.ts` points `schema` at `./src/db/schema`, so drizzle-kit only
 * discovers drizzle objects exported from files in here. The enum lives in
 * `modules/auth/enums.ts` and was merely *imported* by `staff.ts` and
 * `clients.ts`: their columns referenced the type, but nothing ever told
 * drizzle-kit to `CREATE TYPE` it, so `db:push` against a fresh database failed
 * with `type "portal_status" does not exist`. Re-exporting puts it in scope
 * without moving it away from the auth module that owns it.
 *
 * Only this one — the other enums in that file (`account_type_enum`,
 * `onboarding_state_enum`, `staff_status_enum`) back no column in this schema,
 * and their TS names collide with different PG types declared here
 * (`user_account_type`, `account_type`, `staff_status`).
 */
export { portalStatusEnum } from '../../modules/auth/enums';

export const filingTypeEnum = pgEnum('filing_type', [
  'I-130',
  'I-485',
  'I-765',
  'I-140',
  'N-400',
  'I-131',
]);

export const assignmentTypeEnum = pgEnum('assignment_type', ['internal_team', 'external_contractor']);
export const urgencyLevelEnum = pgEnum('urgency_level', ['normal', 'urgent', 'critical']);
export const assignmentStatusEnum = pgEnum('assignment_status', ['pending', 'active', 'completed', 'cancelled']);
