import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { cases } from "./cases";
import { clients } from "./clients";
import { accountTypeEnum } from "./financial-access-controls";
import { invoiceLinePresets } from "./invoice-line-presets";
import { leads } from "./leads";
import { practiceAreas } from "./practice-areas";
import { staff } from "./staff";
import { timeEntries } from "./time-entries";

// =========================================================================
// INVOICING ENUMS
// =========================================================================

/**
 * Stored lifecycle only. `unpaid` and `overdue` are DERIVED at read time and
 * never stored — `overdue` is a pure function of `due_date < today`, and
 * storing it would need a nightly job to stay correct, would be wrong for the
 * hours between midnight and that job, and would fight the payment path for
 * ownership of the column. See `src/modules/finance/status.ts`.
 */
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "partial",
  "paid",
  // Charged, paid, and given back. Distinct from `void`, which says the firm
  // never charged at all — the ledger already tells those apart through the
  // reversal rows, and an invoice that read `sent` after a full refund would
  // reappear as money the client owes and, past its due date, as overdue.
  "refunded",
  "void",
]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "credit_card",
  "bank_transfer",
  "check",
  "cash",
  "wire",
  "other",
]);

// `accountTypeEnum` ('operating' | 'trust_iolta') is reused from
// financial-access-controls.ts rather than redeclared: that table is the gate
// deciding who may see trust data, and a parallel enum would let the ledger and
// the permission model drift apart.

// =========================================================================
// INVOICES
// =========================================================================

/**
 * Money is numeric(15,4) throughout the finance tables — wider than the
 * numeric(10,2) used by older tables. The extra scale carries rate precision
 * through intermediate math; billed line amounts are still rounded half-up to
 * 2dp at write time, so line sums stay exact and no client is billed a
 * fraction of a cent.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),

    /** `INV-2026-0042`. Unique per organization — see the index note below. */
    invoiceNumber: text("invoice_number").notNull(),

    /**
     * Who the invoice bills. Exactly one of `clientId` / `leadId` is set — see
     * the check constraint below.
     *
     * `restrict`, not `cascade`. Deleting a client used to delete their entire
     * billing history along with them, which is not something a finance module
     * should permit: an invoice is a record that the firm asked for money.
     */
    clientId: uuid("client_id").references(() => clients.id, {
      onDelete: "restrict",
    }),
    /**
     * The party before they became a client.
     *
     * Consultation fees and fee agreements are charged during intake, and a
     * `clients` row is only created by `openCase` — which is itself gated on the
     * fee agreement being paid. Billing a lead is what breaks that circle. A
     * lead who never converts (`close_no_case`, `refer_elsewhere`) can still be
     * invoiced for the consultation they had.
     *
     * `openCase` repoints these to the new client on conversion. No cascade
     * deliberately: a lead carrying money cannot be deleted out from under its
     * invoice.
     */
    leadId: uuid("lead_id").references(() => leads.id),
    /**
     * Nullable: an invoice need not hang off a matter (a standalone
     * consultation fee, say). `set null` rather than cascade — a financial
     * record must outlive the matter it belonged to.
     */
    caseId: uuid("case_id").references(() => cases.id, {
      onDelete: "set null",
    }),
    /**
     * Required at create when `caseId` is null, otherwise the revenue-by-
     * practice-area report silently undercounts. Enforced in validation, not
     * by the column, because it is a two-column rule.
     */
    practiceAreaId: uuid("practice_area_id").references(() => practiceAreas.id),
    /**
     * Asked for explicitly at create — it cannot be derived, because
     * `cases.assignedTeamId` is a team, not a person.
     */
    attorneyId: uuid("attorney_id").references(() => staff.id),
    /** Free text; covers the detail view's "filing type" for case-less invoices. */
    filingType: text("filing_type"),

    status: invoiceStatusEnum("status").notNull().default("draft"),
    issueDate: date("issue_date").notNull(),
    /**
     * The date the whole invoice is owed by. When the invoice has a payment
     * schedule this is derived as the FINAL instalment's date on every schedule
     * write, so the header can never contradict the schedule the client was
     * sent.
     */
    dueDate: date("due_date").notNull(),
    /**
     * The date the invoice is NEXT owed money on: the earliest instalment not
     * yet covered by `amount_paid`.
     *
     * NULL means "no schedule" — which is every invoice that does not have one,
     * including every row that predates this column. Read it through
     * `dueBy` in status.ts (`coalesce(next_due_date, due_date)`), never
     * directly: a bare `next_due_date < today` is false on NULL, which would
     * drop unscheduled invoices out of every bucket at once.
     *
     * Stored rather than derived because it is a fold over (schedule,
     * amount_paid), the same category as `amount_paid` below, and deriving it
     * would put a correlated subquery in every list predicate. It is not
     * time-relative, so `overdue` is still decided by comparing it to the
     * firm's today. Maintained only by `recalculateInvoiceTotals()`.
     */
    nextDueDate: date("next_due_date"),

    // ── Denormalized folds ────────────────────────────────────────────────
    // Every tile on the Invoicing tab and every figure on Reports is a SUM
    // over this table, so storing the folds keeps those a single-table scan
    // instead of a GROUP BY join per tile. An invoice is also a legal
    // snapshot: it must not change value because a line's rate was edited
    // later. `recalculateInvoiceTotals()` in finance/totals.ts is the single
    // writer, always inside withTransaction.
    subtotalOperating: numeric("subtotal_operating", {
      precision: 15,
      scale: 4,
    })
      .notNull()
      .default("0"),
    subtotalTrust: numeric("subtotal_trust", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),
    totalAmount: numeric("total_amount", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),
    amountPaid: numeric("amount_paid", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),
    /** Stored generated column: cannot drift from the two it derives from. */
    balanceDue: numeric("balance_due", { precision: 15, scale: 4 })
      .notNull()
      .generatedAlwaysAs(sql`total_amount - amount_paid`),

    /**
     * The detail view shows a single payment method, but partial payments can
     * arrive by different ones — this is the *last* method used. The full
     * ledger is in `invoice_payments`.
     */
    lastPaymentMethod: paymentMethodEnum("last_payment_method"),
    lastPaymentDate: date("last_payment_date"),

    notes: text("notes"),

    /**
     * The client-facing payment link, stored as a SHA-256 of the token.
     *
     * Hash-only, following consultation booking and document requests rather
     * than the fee-agreement signing token, which stores a `randomUUID()` in
     * plaintext with no expiry. Storing only the hash means the link cannot be
     * recovered from the database — and it means resending has to mint a fresh
     * token, which retires the previous link. Rotation is the price of never
     * holding the raw value, and it is the right price for a link that takes
     * money.
     */
    paymentTokenHash: text("payment_token_hash"),
    paymentLinkExpiresAt: timestamp("payment_link_expires_at"),

    sentAt: timestamp("sent_at"),
    paidAt: timestamp("paid_at"),
    voidedAt: timestamp("voided_at"),

    createdById: uuid("created_by_id").references(() => staff.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // Per-org, deliberately NOT global. `cases.case_number` is declared
    // globally unique, which means one firm opening 2026-IMM-001 permanently
    // blocks every other firm from that number — a multi-tenancy leak in the
    // shape of a constraint. Do not repeat it here.
    uniqueIndex("invoices_org_number_uidx").on(
      table.organizationId,
      table.invoiceNumber,
    ),
    // Serves both the status filter and the overdue predicate. The expression
    // matches `dueBy` in status.ts exactly — coalesce over two columns is
    // IMMUTABLE, so the predicates stay sargable, which is the whole
    // justification for storing next_due_date at all.
    index("invoices_org_status_due_idx").on(
      table.organizationId,
      table.status,
      sql`coalesce(next_due_date, due_date)`,
    ),
    index("invoices_org_issue_date_idx").on(
      table.organizationId,
      table.issueDate,
    ),
    index("invoices_client_idx").on(table.clientId),
    index("invoices_lead_idx").on(table.leadId),
    index("invoices_case_idx").on(table.caseId),
    check("invoices_amount_paid_nonneg", sql`${table.amountPaid} >= 0`),
    check("invoices_total_amount_nonneg", sql`${table.totalAmount} >= 0`),
    /**
     * Exactly one billed party, never both and never neither. `<>` on the two
     * null-tests is the same shape `billing_rates` uses for its staff/role
     * exclusivity — the DB is the only place this can actually be guaranteed.
     */
    check(
      "invoices_one_billed_party",
      sql`(${table.clientId} IS NOT NULL) <> (${table.leadId} IS NOT NULL)`,
    ),
  ],
);

// =========================================================================
// INVOICE LINE ITEMS
// =========================================================================

export const invoiceLineItems = pgTable(
  "invoice_line_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Carried rather than inherited from the parent invoice, so the RLS policy
     * is a column comparison instead of a subquery — this is one of the two
     * tables the aggregate queries hit hardest.
     */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),

    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 15, scale: 4 })
      .notNull()
      .default("1"),
    rate: numeric("rate", { precision: 15, scale: 4 }).notNull(),
    /** quantity * rate, rounded half-up to 2dp at write time. */
    amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),

    /** The operating/trust tag that drives the two column totals. */
    account: accountTypeEnum("account").notNull().default("operating"),

    /** Set when this line was converted from an approved time entry. */
    timeEntryId: uuid("time_entry_id").references(() => timeEntries.id, {
      onDelete: "set null",
    }),

    /**
     * Which catalog preset this line was composed from, when it was composed
     * from one at all.
     *
     * Provenance only. `rate` above is the billed figure and is never re-read
     * from the preset — see the note on `invoice_line_presets.default_rate`.
     * `set null` so retiring a preset cannot reach into an invoice the client
     * already holds.
     *
     * Deliberately NOT unique, unlike `time_entry_id` below: the same preset
     * legitimately appears twice on one invoice (two filings, two copies).
     */
    presetId: uuid("preset_id").references(() => invoiceLinePresets.id, {
      onDelete: "set null",
    }),

    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("invoice_line_items_invoice_idx").on(table.invoiceId),
    index("invoice_line_items_org_account_idx").on(
      table.organizationId,
      table.account,
    ),
    // Load-bearing: makes double-billing the same time entry a database error
    // rather than a support ticket. NULLs are permitted and not deduplicated,
    // so manual lines are unaffected.
    uniqueIndex("invoice_line_items_time_entry_uidx").on(table.timeEntryId),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type NewInvoiceLineItem = typeof invoiceLineItems.$inferInsert;
export type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];
export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];

/** The buckets the UI filters on — a superset of the stored statuses. */
export type EffectiveInvoiceStatus =
  | "draft"
  | "unpaid"
  | "partial"
  | "paid"
  | "refunded"
  | "overdue"
  | "void";
