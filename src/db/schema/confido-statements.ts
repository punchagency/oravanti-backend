import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

/**
 * Confido's monthly statement for a firm.
 *
 * The reason this exists is reconciliation. Processing fees never reach
 * `invoice_payments`, and correctly so — they are a firm expense, not a client
 * payment, and not attributable to any single invoice. But Confido debits them
 * monthly from the firm's fee account, which leaves a debit sitting between our
 * operating figure and the firm's bank balance. Without the statement that gap
 * is unexplainable; with it, it is a line item.
 *
 * The trust account needs none of this: deposits are gross and fees never touch
 * it, so `sum(amount_trust)` reconciles exactly on its own.
 *
 * A statement exists only for months in which the firm processed something, so
 * gaps in this table are expected rather than missing data.
 */
export const confidoStatements = pgTable(
  "confido_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    /** Confido's id. Unique because `statement.updated` replaces rather than adds. */
    confidoStatementId: text("confido_statement_id").notNull(),
    /** `YYYY-MM`, as Confido reports it. */
    month: text("month").notNull(),

    /** Everything processed across both accounts and all payment methods. */
    paymentVolume: numeric("payment_volume", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),
    /** Total charged to the firm, INCLUDING anything clients paid via surcharge. */
    totalFees: numeric("total_fees", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),
    feesPaidByClients: numeric("fees_paid_by_clients", {
      precision: 15,
      scale: 4,
    })
      .notNull()
      .default("0"),
    /** What the firm actually bore: total less the part clients paid. */
    netFees: numeric("net_fees", { precision: 15, scale: 4 })
      .notNull()
      .default("0"),

    /**
     * Per-bank-account volume and fee breakdown, as Confido reports it.
     *
     * Kept as jsonb rather than a third table: it is display detail read whole,
     * never queried across, and its shape is Confido's to change. The debits —
     * which ARE queried, because "what did we pay in fees this year" is a
     * question — get their own table.
     *
     * Worth knowing when reading it: Confido attributes fees per RECEIVING
     * account, including trust, but debits them from the single fee account. A
     * trust payment does incur a fee; the money simply never leaves trust.
     */
    bankAccounts: jsonb("bank_accounts"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("confido_statements_statement_uidx").on(
      table.confidoStatementId,
    ),
    index("confido_statements_org_month_idx").on(
      table.organizationId,
      table.month,
    ),
  ],
);

/**
 * One debit Confido will take from the firm's fee account.
 *
 * These are the reconciliation lines: the entry that explains why the operating
 * bank balance is lower than what our ledger says was collected.
 *
 * Its own table rather than jsonb because it is queried across months, and
 * because `fromBankAccountCategory` is the column that proves fees came out of
 * operating rather than trust — which is the whole safety property.
 */
export const confidoStatementDebits = pgTable(
  "confido_statement_debits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => confidoStatements.id, { onDelete: "cascade" }),

    amount: numeric("amount", { precision: 15, scale: 4 }).notNull(),
    /** `operating` or `trust`. Should always be operating; worth being able to prove. */
    fromBankAccountCategory: text("from_bank_account_category"),
    fromBankAccountMask: text("from_bank_account_mask"),
    /** What the firm will see on their bank statement. */
    statementDescriptor: text("statement_descriptor"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("confido_statement_debits_statement_idx").on(table.statementId),
    index("confido_statement_debits_org_idx").on(table.organizationId),
  ],
);

export type ConfidoStatement = typeof confidoStatements.$inferSelect;
export type ConfidoStatementDebit = typeof confidoStatementDebits.$inferSelect;
