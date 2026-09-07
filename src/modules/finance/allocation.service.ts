import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { invoiceLineItems, invoices } from "../../db/schema/invoices";
import { applicationSplit } from "./allocation";
import { num, trustFirstSplit } from "./money";

/**
 * The database-reading companion to the pure `allocation.ts`.
 *
 * Its own module, and for the reason `instalments.ts` and
 * `instalments.service.ts` are separate: both `payments.service.ts` and
 * `payment-links.service.ts` need this, and `payments → deliveries →
 * payment-links` is already an import chain. Putting it in either one would
 * close that into a cycle.
 */

/**
 * The split a payment takes when the caller names none.
 *
 * Reads the order the invoice's agreement promised the client and applies it
 * across the fee and cost lines; falls back to `trustFirstSplit` when there is
 * no order, or when any line is unclassified. Shared with
 * `payment-links.service.ts`, so the link asks Confido for exactly the legs the
 * payment will be booked to.
 */
export const agreedSplit = async (
  organizationId: string,
  invoiceId: string,
  amount: number,
  alreadyPaid: number,
  operatingOutstanding: number,
  trustOutstanding: number,
) => {
  const [invoice] = await db
    .select({
      order: invoices.paymentApplicationOrder,
      feePercent: invoices.paymentApplicationFeePercent,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  // Skip the line read entirely when there is no order to honour — which is
  // every invoice raised before this existed, and every consultation.
  if (!invoice?.order) {
    return trustFirstSplit(amount, operatingOutstanding, trustOutstanding);
  }

  const lines = await db
    .select({
      amount: invoiceLineItems.amount,
      account: invoiceLineItems.account,
      category: invoiceLineItems.category,
    })
    .from(invoiceLineItems)
    .where(
      and(
        eq(invoiceLineItems.organizationId, organizationId),
        eq(invoiceLineItems.invoiceId, invoiceId),
      ),
    );

  return applicationSplit(
    amount,
    lines.map((l) => ({
      amount: num(l.amount),
      account: l.account,
      category: l.category,
    })),
    alreadyPaid,
    invoice.order,
    invoice.feePercent,
    operatingOutstanding,
    trustOutstanding,
  );
};
