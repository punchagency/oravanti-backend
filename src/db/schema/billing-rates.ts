import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { staff, staffRoleEnum } from "./staff";

/**
 * Effective-dated billing rates — the source of truth for what an hour of work
 * is worth.
 *
 * Why this exists rather than reading `staff.hourlyRate`: that column is a
 * single mutable scalar, so any figure computed from it at read time silently
 * restates itself the moment someone gets a raise, and work logged late is
 * valued at today's rate rather than the rate that applied when the work was
 * actually done.
 *
 * The rule is: resolve by the *entry's* date, never `now()`.
 *
 *   effective_from <= :entryDate AND (effective_to IS NULL OR :entryDate < effective_to)
 *
 * A row targets one person (`staffId`) or one role (`role`) — never both,
 * never neither. A personal rate beats the role default; the role default is
 * what stops a new hire with no rate row from billing at $0.
 *
 * A rate change is an INSERT, never an UPDATE. History is the entire point of
 * the table. The service closes the previous open row (`effectiveTo` = the new
 * `effectiveFrom`) in the same transaction as the insert.
 *
 * The resolved rate is then snapshotted onto the time entry — see
 * `time-entries.ts` — and frozen permanently once the entry is invoiced.
 *
 * See `src/modules/finance/billing-rates.service.ts`.
 */
export const billingRates = pgTable(
  "billing_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),

    /** Set for a person-specific rate; null for a role default. */
    staffId: uuid("staff_id").references(() => staff.id, {
      onDelete: "cascade",
    }),
    /** Set for a firm-wide role default; null for a person-specific rate. */
    role: staffRoleEnum("role"),

    rate: numeric("rate", { precision: 15, scale: 4 }).notNull(),

    effectiveFrom: date("effective_from").notNull(),
    /** Null means "still in force". At most one such row per target. */
    effectiveTo: date("effective_to"),

    createdById: uuid("created_by_id").references(() => staff.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "billing_rates_target_exclusive",
      sql`(${table.staffId} IS NOT NULL)::int + (${table.role} IS NOT NULL)::int = 1`,
    ),
    check("billing_rates_rate_nonneg", sql`${table.rate} >= 0`),
    check(
      "billing_rates_range_ordered",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
    index("billing_rates_org_staff_from_idx").on(
      table.organizationId,
      table.staffId,
      table.effectiveFrom,
    ),
    index("billing_rates_org_role_from_idx").on(
      table.organizationId,
      table.role,
      table.effectiveFrom,
    ),
    // At most one open row per target. This single invariant is what keeps
    // effective ranges from overlapping, without needing a gist exclusion
    // constraint — closing the old row is then mandatory before opening a new
    // one, which the service does in one transaction.
    uniqueIndex("billing_rates_open_staff_uidx")
      .on(table.organizationId, table.staffId)
      .where(sql`effective_to IS NULL AND staff_id IS NOT NULL`),
    uniqueIndex("billing_rates_open_role_uidx")
      .on(table.organizationId, table.role)
      .where(sql`effective_to IS NULL AND role IS NOT NULL`),
  ],
);

export type BillingRate = typeof billingRates.$inferSelect;
export type NewBillingRate = typeof billingRates.$inferInsert;
