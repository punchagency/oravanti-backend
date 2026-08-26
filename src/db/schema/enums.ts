import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Portal access status, shared by `staff` and `clients`.
 *
 * Declared HERE and not in `src/modules/auth/enums.ts`, where it originally
 * sat, because `drizzle.config.ts` points `schema` at `./src/db/schema` only.
 * A pgEnum declared outside that glob is invisible to drizzle-kit, so it
 * emitted the two columns without ever emitting `CREATE TYPE portal_status`
 * and every generated migration failed with:
 *
 *     type "portal_status" does not exist
 *
 * The other enums in that file are unaffected only because nothing inside the
 * glob references them — the tables that look like they should use them
 * (`user.account_type`, `staff.status`) resolve to separately-declared types
 * with different names. Anything a table in this directory references has to
 * be declared in this directory.
 */
export const portalStatusValues = [
  'none',
  'pending',
  'active',
  'disabled',
] as const;
export type PortalStatus = (typeof portalStatusValues)[number];
export const portalStatusEnum = pgEnum('portal_status', portalStatusValues);

export const filingTypeEnum = pgEnum('filing_type', [
  'I-130',
  'I-485',
  'I-765',
  'I-140',
  'N-400',
  'I-131',
  // Types the mandamus case's own `cases` row (separate from the parent
  // AOS/N-400 matter, see immigration-case-details.ts) can be filed as.
  'MANDAMUS',
]);

export const assignmentTypeEnum = pgEnum('assignment_type', ['internal_team', 'external_contractor']);
export const urgencyLevelEnum = pgEnum('urgency_level', ['normal', 'urgent', 'critical']);
export const assignmentStatusEnum = pgEnum('assignment_status', ['pending', 'active', 'completed', 'cancelled']);
