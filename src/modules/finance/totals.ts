import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { invoiceInstalments } from "../../db/schema/invoice-instalments";
import { invoicePayments } from "../../db/schema/invoice-payments";
import {
  invoiceLineItems,
  invoices,
  type InvoiceStatus,
} from "../../db/schema/invoices";
import { nextDueDateFrom } from "./instalments";
import { money, num } from "./money";

/**
 * The single writer of an invoice's denormalized folds.
 *
 * `subtotal_operating`, `subtotal_trust`, `total_amount` and `amount_paid` are
 * stored on the header rather than derived, because every tile on the Invoicing
 * tab and every figure on Reports is a SUM over `invoices` — deriving would
 * force a GROUP BY join per tile. (`balance_due` is a generated column, so it
 * follows automatically and cannot drift.)
 *
 * Must be called inside `withTransaction` by every path that touches line items
 * or payments, so the folds and their sources commit together.
 */

/**
 * Derive the stored status from the money.
 *
 * `>=` rather than `===` so an overpayment marks the invoice paid instead of
 * sticking at `partial` forever. `draft` and `void` are lifecycle facts that
 * payments must never overwrite — a voided invoice stays voided even if a
 * stray payment lands against it.
 */
export const deriveStoredStatus = (
  current: InvoiceStatus,
  totalAmount: number,
  amountPaid: number,
): InvoiceStatus => {
  if (current === "void" || current === "draft") return current;
  if (totalAmount > 0 && amountPaid >= totalAmount) return "paid";
  if (amountPaid > 0) return "partial";
  return "sent";
};

export type InvoiceTotals = {
  subtotalOperating: number;
  subtotalTrust: number;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  status: InvoiceStatus;
  /** Null when the invoice has no schedule, or every instalment is covered. */
  nextDueDate: string | null;
};

export const recalculateInvoiceTotals = async (
  organizationId: string,
  invoiceId: string,
): Promise<InvoiceTotals> => {
  const [lineFold] = await db
    .select({
      operating: sql<string>`coalesce(sum(${invoiceLineItems.amount}) FILTER (WHERE ${invoiceLineItems.account} = 'operating'), 0)`,
      trust: sql<string>`coalesce(sum(${invoiceLineItems.amount}) FILTER (WHERE ${invoiceLineItems.account} = 'trust_iolta'), 0)`,
    })
    .from(invoiceLineItems)
    .where(
      and(
        eq(invoiceLineItems.organizationId, organizationId),
        eq(invoiceLineItems.invoiceId, invoiceId),
      ),
    );

  const [paymentFold] = await db
    .select({
      paid: sql<string>`coalesce(sum(${invoicePayments.amount}), 0)`,
      lastDate: sql<
        string | null
      >`max(${invoicePayments.paymentDate})`,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    );

  const [current] = await db
    .select({ status: invoices.status })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  const subtotalOperating = num(lineFold?.operating);
  const subtotalTrust = num(lineFold?.trust);
  const totalAmount = subtotalOperating + subtotalTrust;
  const amountPaid = num(paymentFold?.paid);

  const status = deriveStoredStatus(
    (current?.status ?? "draft") as InvoiceStatus,
    totalAmount,
    amountPaid,
  );

  // The earliest instalment the payments have not reached. Recomputed here
  // rather than anywhere else because it is a fold over (schedule, amountPaid),
  // and this function is the single writer of the folds — a second writer is
  // how a cached date starts pointing at a day nobody can see.
  const schedule = await db
    .select({
      sequence: invoiceInstalments.sequence,
      dueDate: invoiceInstalments.dueDate,
      amount: invoiceInstalments.amount,
    })
    .from(invoiceInstalments)
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        eq(invoiceInstalments.invoiceId, invoiceId),
      ),
    );

  const nextDueDate = schedule.length
    ? nextDueDateFrom(
        schedule.map((s) => ({
          sequence: s.sequence,
          dueDate: s.dueDate,
          amount: num(s.amount),
        })),
        amountPaid,
      )
    : null;

  // The most recent payment's method, for the detail view's single
  // "payment method" field. Partial payments can arrive by different methods;
  // the full ledger lives in invoice_payments.
  const [latest] = await db
    .select({
      method: invoicePayments.method,
      paymentDate: invoicePayments.paymentDate,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    )
    .orderBy(sql`${invoicePayments.paymentDate} DESC, ${invoicePayments.createdAt} DESC`)
    .limit(1);

  await db
    .update(invoices)
    .set({
      subtotalOperating: money(subtotalOperating),
      subtotalTrust: money(subtotalTrust),
      totalAmount: money(totalAmount),
      amountPaid: money(amountPaid),
      status,
      nextDueDate,
      lastPaymentMethod: latest?.method ?? null,
      lastPaymentDate: latest?.paymentDate ?? null,
      paidAt: status === "paid" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    );

  return {
    subtotalOperating,
    subtotalTrust,
    totalAmount,
    amountPaid,
    balanceDue: totalAmount - amountPaid,
    status,
    nextDueDate,
  };
};
