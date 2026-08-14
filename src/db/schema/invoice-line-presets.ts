import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { accountTypeEnum } from "./financial-access-controls";
import { practiceAreaCaseTypes } from "./practice-area-case-types";
import { practiceAreas } from "./practice-areas";
import { staff } from "./staff";

/**
 * The catalog manual invoice lines are composed from.
 *
 * Composing an invoice used to mean retyping every charge: description,
 * amount, and the operating/trust tag, from memory. That produces three errors
 * worth a table to prevent — a filing fee typed at the wrong amount, a filing
 * fee filed against Operating when it is client money the firm merely holds,
 * and the same charge worded five ways so it cannot be reported on.
 *
 * Two tiers live here, distinguished only by `organization_id`:
 *
 *   - **Shipped** (`organization_id IS NULL`) — seeded with the product,
 *     visible to every firm, managed via the CLI alongside the practice-area
 *     taxonomy it is scoped by.
 *   - **Firm-owned** (`organization_id` set) — saved by staff from a custom
 *     line they typed.
 *
 * A firm may not edit a shipped row; it *shadows* one instead, by inserting
 * its own row carrying `shadows_preset_id`. That keeps a CLI correction
 * reaching every firm that has not deliberately overridden it, which cloning
 * the catalog per firm at signup would not. The RLS policy in `rls.ts` is what
 * actually enforces this: its `using` clause admits NULL, its `with check`
 * clause does not.
 *
 * See `src/modules/finance/line-presets.service.ts`.
 */
export const invoiceLinePresets = pgTable(
  "invoice_line_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * NULL for a shipped preset, set for a firm's own.
     *
     * Nullable deliberately, unlike every other finance table — the shared
     * tier is the entire point. Note this makes it the one table here whose
     * RLS read and write clauses differ.
     */
    organizationId: text("organization_id").references(() => organization.id),

    /**
     * The shipped preset this firm row replaces. The list query hides any
     * shipped row the firm has shadowed.
     *
     * Nothing writes this yet — editing a preset is a later piece of work. The
     * column and the list-side filter exist now so that work is additive
     * rather than a migration.
     */
    shadowsPresetId: uuid("shadows_preset_id").references(
      (): AnyPgColumn => invoiceLinePresets.id,
      { onDelete: "cascade" },
    ),

    /** Becomes `invoice_line_items.description` verbatim. */
    name: varchar("name", { length: 255 }).notNull(),
    /** Shown under the name in the picker to disambiguate. Never billed. */
    note: text("note"),

    /**
     * Which account the charge belongs in — the first thing staff pick, and
     * the error this table most wants to prevent. Same enum the line item
     * carries, so a preset cannot describe an account a line cannot hold.
     */
    account: accountTypeEnum("account").notNull(),

    /**
     * The seed value for `invoice_line_items.rate`, COPIED at add time and
     * never read back. An invoice is a snapshot: it must not restate itself
     * because a published fee schedule moved. Same doctrine as
     * billing_rates -> time_entries.
     */
    defaultRate: numeric("default_rate", { precision: 15, scale: 4 }).notNull(),

    /**
     * Scope. Both null means the preset shows for every invoice (postage,
     * photocopying). A case type is the right granularity only where the
     * charge really is per-form — the per-petition USCIS fees — and everything
     * else sits at practice-area level.
     */
    practiceAreaId: uuid("practice_area_id").references(
      () => practiceAreas.id,
      { onDelete: "cascade" },
    ),
    caseTypeId: uuid("case_type_id").references(
      () => practiceAreaCaseTypes.id,
      { onDelete: "cascade" },
    ),

    /** Retired rather than deleted, so lines already citing it keep their id. */
    active: boolean("active").notNull().default(true),

    createdById: uuid("created_by_id").references(() => staff.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("invoice_line_presets_rate_nonneg", sql`${table.defaultRate} >= 0`),
    // Only a firm row may shadow. A shipped row shadowing another would be
    // unreachable by the firm that wanted it gone.
    check(
      "invoice_line_presets_shadow_is_firm_owned",
      sql`${table.shadowsPresetId} IS NULL OR ${table.organizationId} IS NOT NULL`,
    ),
    index("invoice_line_presets_org_account_area_idx").on(
      table.organizationId,
      table.account,
      table.practiceAreaId,
    ),
    // Two PARTIAL unique indexes, so the tiers dedupe independently.
    //
    // `coalesce` over the scope columns because Postgres treats NULLs as
    // distinct in a unique index — without it "Postage" could be inserted
    // unscoped any number of times, which is precisely the duplication this
    // table exists to end. `coalesce` is IMMUTABLE, so both stay usable as
    // conflict targets, and that is what lets the seed and the save-custom-line
    // path both be a single `onConflictDoUpdate` rather than read-then-write.
    uniqueIndex("invoice_line_presets_firm_uidx")
      .on(
        table.organizationId,
        table.account,
        sql`lower(${table.name})`,
        sql`coalesce(${table.practiceAreaId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${table.caseTypeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`organization_id IS NOT NULL`),
    uniqueIndex("invoice_line_presets_shipped_uidx")
      .on(
        table.account,
        sql`lower(${table.name})`,
        sql`coalesce(${table.practiceAreaId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`coalesce(${table.caseTypeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`organization_id IS NULL`),
  ],
);

export type InvoiceLinePreset = typeof invoiceLinePresets.$inferSelect;
export type NewInvoiceLinePreset = typeof invoiceLinePresets.$inferInsert;
