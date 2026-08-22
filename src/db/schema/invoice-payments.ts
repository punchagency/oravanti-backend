import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  uniqueIndex,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { invoices, paymentMethodEnum } from "./invoices";
import { staff } from "./staff";

/**
 * What a ledger row represents.
 *
 * `payment` is money in. Everything else is money going back out, and every
 * other value is stored with a NEGATIVE amount — see the sign constraint below.
 *
 * `reversal` is a deliberate catch-all. We classify from Confido's webhook
 * event type, which is a closed documented set, but a reversal we cannot name
 * is still money that moved: recording it imprecisely beats dropping it.
 */
export const paymentEntryKindEnum = pgEnum("payment_entry_kind", [
  "payment",
  "refund",
  "return",
  "void",
  "chargeback",
  "reversal",
]);

/**
 * The payment ledger. Partial payments mean N rows per invoice;
 * `invoices.amountPaid` is the cached fold of this table.
 *
 * `amountOperating` / `amountTrust` are the load-bearing columns. The Reports
 * tab needs "filing fees collected" and "held in trust pending"; if a $1,500
 * trust / $500 operating invoice receives $600, nothing else in the data says
 * how much of that was trust money. Pro-rating at read time is cheap but
 * legally wrong — IOLTA funds must be tracked, not estimated. The service
 * pro-rates as the default when the caller omits the split (so the simple
 * Record-payment form still works), but the number is then stored, auditable
 * and correctable.
 *
 * ## Reversals are signed, not flagged
 *
 * Refunds, ACH returns, voids and chargebacks are rows with a negative
 * `amount`, not positive rows a reader is expected to subtract. Confido models
 * a return the other way — a separate transaction with a POSITIVE amount
 * pointing back at the original — so this is a deliberate divergence at our
 * boundary rather than an accident of ingest.
 *
 * The reason is what happens when a future reader forgets the rule. Four of the
 * five things that read this table sum money (`totals.ts`, `sumPaidBySide`,
 * `outstandingBySide`, the trust figure on Reports). Under a positive-plus-kind
 * model a forgotten filter makes a refunded invoice read as paid TWICE over —
 * the reversal adding to the total it was meant to subtract from, in the one
 * direction nobody investigates. Signed, the same omission yields the net
 * figure, which is the correct answer at all four sites. Gross collections have
 * to be asked for explicitly, which is the right way round.
 */
export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),

    /** Negative on every kind but `payment`. Enforced below. */
    amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),
    amountOperating: numeric("amount_operating", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),
    amountTrust: numeric("amount_trust", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),

    /**
     * Money in, or which way it went back out.
     *
     * Defaulted so the backfill is correct without touching a row: every
     * payment recorded before this column existed was money arriving.
     */
    kind: paymentEntryKindEnum("kind").notNull().default("payment"),
    /**
     * The row this one undoes. Null on a payment.
     *
     * A reversal we cannot match to a recorded payment is NOT written at all —
     * see `recordReversal`. Subtracting money we never added would drive
     * `amount_paid` negative and mark a paid invoice unpaid, which is a worse
     * outcome than an unreconciled line a human has to look at.
     */
    reversesPaymentId: uuid("reverses_payment_id").references(
      (): AnyPgColumn => invoicePayments.id,
      { onDelete: "restrict" },
    ),

    paymentDate: date("payment_date").notNull(),
    method: paymentMethodEnum("method").notNull(),
    /** Cheque number, wire reference, gateway transaction id. */
    reference: text("reference"),
    notes: text("notes"),

    /**
     * Which payment provider reported this, and its id for the payment.
     *
     * Null on a payment a member of staff entered by hand. Set by a provider
     * webhook.
     *
     * The unique index below is the point of both columns: a webhook that is
     * replayed — and providers do replay, that is what "at least once delivery"
     * means — hits a constraint violation instead of recording the same money
     * twice.
     */
    provider: text("provider"),
    providerReference: text("provider_reference"),

    /**
     * When the money actually landed, as distinct from when it was reported.
     *
     * Null while in flight. Stored rather than derived from `providerStatus`
     * because the date cannot be recovered once the status moves on, and
     * because it is what the case-opening gate consults.
     *
     *   - staff entry      — set at insert; nobody is going to send a webhook
     *   - provider payment — null at insert, filled by `transaction.deposited`
     *   - reversal         — set at insert, deliberately. Money leaving counts
     *                        against the firm at once; money arriving counts
     *                        only when it has cleared.
     */
    settledAt: timestamp("settled_at"),
    /**
     * Confido's `status_v2`, verbatim and untranslated.
     *
     * Kept alongside `settledAt` so `HELD` — their high-dollar risk review,
     * which a USCIS filing fee is exactly the shape to trigger — stays
     * distinguishable from an ordinary `PENDING`. The gate treats the two
     * differently, and a firm watching money sit for a week is owed a better
     * answer than a spinner.
     */
    providerStatus: text("provider_status"),

    recordedById: uuid("recorded_by_id").references(() => staff.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("invoice_payments_invoice_idx").on(table.invoiceId),
    // Partial: hand-entered rows leave both columns null, and Postgres treats
    // NULLs as distinct, but stating the predicate makes the intent explicit
    // and keeps the index to the rows it is actually for.
    uniqueIndex("invoice_payments_provider_ref_uidx")
      .on(table.provider, table.providerReference)
      .where(sql`provider IS NOT NULL AND provider_reference IS NOT NULL`),
    index("invoice_payments_org_date_idx").on(
      table.organizationId,
      table.paymentDate,
    ),
    index("invoice_payments_reverses_idx").on(table.reversesPaymentId),
    /**
     * Sign follows kind: money in is positive, money back out is negative.
     *
     * Enumerated rather than written as `amount <> 0` on purpose. The first
     * positive non-payment — a chargeback REVERSAL, when the firm wins the
     * dispute — cannot be added without editing this constraint, which puts the
     * sign question in front of whoever writes that migration instead of
     * letting it through on a default.
     */
    check(
      "invoice_payments_amount_sign",
      sql`case when ${table.kind} = 'payment' then ${table.amount} > 0 else ${table.amount} < 0 end`,
    ),
    check(
      "invoice_payments_split_balances",
      sql`${table.amountOperating} + ${table.amountTrust} = ${table.amount}`,
    ),
    /** A reversal points at what it reverses; a payment never does. */
    check(
      "invoice_payments_reverses_matches_kind",
      sql`(${table.kind} = 'payment') = (${table.reversesPaymentId} IS NULL)`,
    ),
  ],
);

export type InvoicePayment = typeof invoicePayments.$inferSelect;
export type NewInvoicePayment = typeof invoicePayments.$inferInsert;
export type PaymentEntryKind = (typeof paymentEntryKindEnum.enumValues)[number];
