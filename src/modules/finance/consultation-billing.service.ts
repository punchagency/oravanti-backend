import { and, eq } from "drizzle-orm";
import { netPaidOnInvoice } from "./refunds.service";
import { db } from "../../db/client";
import { consultations } from "../../db/schema/consultations";
import { invoices } from "../../db/schema/invoices";
import { leads } from "../../db/schema/leads";
import { createModuleLogger } from "../../lib/logging/log";
import { systemAccess } from "./account-access";
import { create } from "./invoices.service";
import { num } from "./money";
import { firmToday } from "./status";

const log = createModuleLogger("consultation-billing.service");

/**
 * Consultation fees, as invoices.
 *
 * A consultation fee used to be a `numeric(10,2)` column and a four-value enum
 * on the consultation row: no ledger, no payment record, no amount paid, no
 * receipt, and `"waived"` declared in the enum but written nowhere in the
 * codebase. It also appeared in no revenue report — `revenue-analytics` sums
 * time entries and `finance/reports` sums invoices, so a paid consultation fee
 * was worth zero everywhere.
 *
 * It is now an invoice raised against the LEAD, which is the only party that
 * exists at this stage of the pipeline.
 */

/** How long a consultation invoice is given before it is considered late. */
const TERMS_DAYS = 14;

const addDays = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
};

export type ConsultationFeeInput = {
  consultationId: string;
  leadId: string;
  /** What is actually charged, surcharge included. */
  amount: number;
  /** Pre-surcharge, when a multiplier was applied — for the line description. */
  baseAmount: number | null;
  emergencyMultiplier: number | null;
  mode: string;
  scheduledAt: Date | null;
  /** `pay_now` is due immediately; the consultation does not start until paid. */
  dueImmediately: boolean;
};

/**
 * Raise the invoice for a consultation fee and link it back.
 *
 * Created as a DRAFT. Sending is a separate act everywhere in this module, and
 * the consultation flow has its own moment for it: `pay_now` sends at once,
 * `invoice_after` when the call is completed, `pay_in_person` never — staff
 * record the payment directly.
 *
 * Returns null when there is no practice area on the lead. The invoice would be
 * refused by validation (a practice area is required when there is no matter,
 * or revenue-by-practice-area silently undercounts it), and failing the whole
 * consultation booking over a billing detail would be the wrong trade.
 */
export const raiseConsultationInvoice = async (
  organizationId: string,
  actorStaffId: string | null,
  input: ConsultationFeeInput,
): Promise<string | null> => {
  const [lead] = await db
    .select({ practiceAreaId: leads.practiceAreaId })
    .from(leads)
    .where(and(eq(leads.organizationId, organizationId), eq(leads.id, input.leadId)))
    .limit(1);

  if (!lead?.practiceAreaId) return null;

  const today = await firmToday(organizationId);
  const when = input.scheduledAt
    ? input.scheduledAt.toISOString().slice(0, 10)
    : today;

  // The multiplier is named rather than folded silently into the number. A
  // client asked for $450 when the firm's published fee is $300 is owed the
  // arithmetic.
  const description =
    input.emergencyMultiplier != null && input.baseAmount != null
      ? `Consultation (${input.mode.replace(/_/g, " ")}) on ${when} — emergency rate, ${input.baseAmount.toFixed(2)} × ${input.emergencyMultiplier}`
      : `Consultation (${input.mode.replace(/_/g, " ")}) on ${when}`;

  const invoice = await create(organizationId, actorStaffId, systemAccess(), {
    leadId: input.leadId,
    practiceAreaId: lead.practiceAreaId,
    issueDate: today,
    dueDate: input.dueImmediately ? today : addDays(today, TERMS_DAYS),
    status: "draft",
    lineItems: [
      {
        description,
        quantity: 1,
        rate: input.amount,
        // A consultation fee is earned income, never client money held.
        account: "operating",
      },
    ],
    timeEntryIds: [],
  });

  await db
    .update(consultations)
    .set({ invoiceId: invoice.id, updatedAt: new Date() })
    .where(eq(consultations.id, input.consultationId));

  log.action("consultation_billing.generated", { consultationId: input.consultationId, invoiceId: invoice.id });

  return invoice.id;
};

export type ConsultationFee = {
  amount: number | null;
  status: "none" | "unpaid" | "paid" | "waived";
  invoiceId: string | null;
  invoiceNumber: string | null;
  /**
   * What the firm is still holding of this fee.
   *
   * Net of reversals by construction — a refund is a negative ledger row — so
   * it answers two questions at once: how much a cancellation would send back,
   * and, once the consultation IS cancelled, how much is still owed. The
   * caller decides which of those it is; nothing is stored either way, so it
   * cannot fall out of step with the ledger.
   */
  netPaid: number;
};

/**
 * The fee as it stands, preferring the invoice.
 *
 * The legacy columns are the fallback, not the source: a consultation booked
 * before invoicing existed still has to report its fee. That coalesce is the
 * same discipline as `next_due_date` — a missing value means "this predates the
 * feature", not "unknown".
 *
 * `"waived"` finally means something. It has been in the enum since the table
 * was written and was never once assigned; a voided fee invoice is exactly what
 * waiving a fee is.
 */
export const consultationFee = async (
  organizationId: string,
  row: {
    invoiceId: string | null;
    feeAmount: string | null;
    feeStatus: "none" | "unpaid" | "paid" | "waived";
  },
): Promise<ConsultationFee> => {
  if (!row.invoiceId) {
    return {
      amount: row.feeAmount == null ? null : num(row.feeAmount),
      status: row.feeStatus,
      invoiceId: null,
      invoiceNumber: null,
      // No invoice means no ledger rows. The legacy `feeStatus` flag was never
      // backed by money moving, so claiming an amount is held would be a guess.
      netPaid: 0,
    };
  }

  const [invoice] = await db
    .select({
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      totalAmount: invoices.totalAmount,
      balanceDue: invoices.balanceDue,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, row.invoiceId),
      ),
    )
    .limit(1);

  if (!invoice) {
    // The link points at nothing. Report the legacy columns rather than
    // inventing a status.
    return {
      amount: row.feeAmount == null ? null : num(row.feeAmount),
      status: row.feeStatus,
      invoiceId: row.invoiceId,
      invoiceNumber: null,
      netPaid: 0,
    };
  }

  return {
    amount: num(invoice.totalAmount),
    status:
      invoice.status === "void"
        ? "waived"
        : num(invoice.balanceDue) <= 0
          ? "paid"
          : "unpaid",
    invoiceId: row.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    netPaid: await netPaidOnInvoice(organizationId, row.invoiceId),
  };
};
