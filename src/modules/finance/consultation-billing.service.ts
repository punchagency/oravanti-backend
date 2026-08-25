import { and, asc, eq, inArray } from "drizzle-orm";
import { netPaidOnInvoice } from "./refunds.service";
import { db } from "../../db/client";
import {
  LIVE_CONSULTATION_STATUSES,
  consultations,
} from "../../db/schema/consultations";
import { consultationSettings } from "../../db/schema/consultation-settings";
import { invoiceInstalments } from "../../db/schema/invoice-instalments";
import { invoices } from "../../db/schema/invoices";
import { leads } from "../../db/schema/leads";
import { createModuleLogger } from "../../lib/logging/log";
import { systemAccess } from "./account-access";
import { create } from "./invoices.service";
import { setSchedule } from "./instalments.service";
import { num, toMoney } from "./money";
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
  /**
   * The deposit as a percentage of the fee, when the firm collects one. The
   * balance falls due after the consultation.
   */
  upfrontPercent?: number | null;
};

/**
 * Raise the invoice for a consultation fee and link it back.
 *
 * Created as a DRAFT. Sending is a separate act everywhere in this module, and
 * the consultation flow has its own moment for it: `pay_now` sends at once,
 * `invoice_after` when the call is completed, `pay_in_person` never — staff
 * record the payment directly.
 *
 * The two that are not emailed are still ISSUED (`issueInvoice`) rather than
 * left in draft. A draft is excluded from `countableInvoices`, so a fee
 * collected in cash would otherwise be missing from every revenue report while
 * sitting in the till.
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

  // A deposit is two dated slices of ONE invoice, not two invoices. Two would
  // mean two numbers, two dunning tracks and a reconciliation problem;
  // `invoice_instalments` exists precisely to avoid that, and
  // `assertScheduleBalances` guarantees the slices sum to the total inside the
  // same transaction as the write.
  if (input.upfrontPercent != null && input.amount > 0) {
    // Rounding lands on the deposit and the balance is the remainder, so the
    // two always sum to the total exactly — never round(a) + round(b), which
    // can miss by a cent and trip the balance assertion.
    const deposit = toMoney((input.amount * input.upfrontPercent) / 100);
    const balance = toMoney(input.amount - deposit);

    // A deposit that rounds to nothing, or to the whole fee, is not a deposit.
    // Falling back to a single-payment invoice is better than writing a
    // schedule with a zero slice, which `assertScheduleBalances` would reject
    // and which would take the whole booking down with it.
    if (deposit > 0 && balance > 0) {
      // The balance is due when the consultation happens; an unscheduled one
      // falls back to the standard terms.
      const balanceDue = input.scheduledAt
        ? input.scheduledAt.toISOString().slice(0, 10)
        : addDays(today, TERMS_DAYS);

      // Strictly after the deposit, always. `setSchedule` renumbers sequence
      // into due-date order, so two slices sharing a date have no deterministic
      // tiebreaker — and the booking gate reads sequence 1 as the deposit. An
      // instant consultation is scheduled for today, which is exactly when that
      // collision happens, and it would silently gate on the balance instead.
      const dueDate = balanceDue > today ? balanceDue : addDays(today, 1);

      await setSchedule(
        organizationId,
        invoice.id,
        [
          { dueDate: today, amount: deposit },
          { dueDate, amount: balance },
        ],
        actorStaffId,
        systemAccess(),
      );
    }
  }

  await db
    .update(consultations)
    .set({ invoiceId: invoice.id, updatedAt: new Date() })
    .where(eq(consultations.id, input.consultationId));

  log.action("consultation_billing.generated", { consultationId: input.consultationId, invoiceId: invoice.id });

  return invoice.id;
};

export type ConsultationFee = {
  amount: number | null;
  status: "none" | "unpaid" | "paid" | "waived" | "refunded";
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
    // Order matters. A refunded invoice has its full balance outstanding again
    // — the reversal nets `amount_paid` to zero — so testing the balance first
    // would report it as "unpaid" and invite someone to chase it. And it is not
    // "waived": the firm charged and was paid, then gave the money back.
    status:
      invoice.status === "void"
        ? "waived"
        : invoice.status === "refunded"
          ? "refunded"
          : num(invoice.balanceDue) <= 0
            ? "paid"
            : "unpaid",
    invoiceId: row.invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    netPaid: await netPaidOnInvoice(organizationId, row.invoiceId),
  };
};

// ── The booking gate ─────────────────────────────────────────────────────────

/**
 * Is money still owed before this consultation may be booked?
 *
 * Replaces the old `consultation.feeStatus === "unpaid"` test, which was a
 * stored enum standing in for a ledger. The two drifted, and each way they
 * drifted was a bug:
 *
 *   - Voiding an unpaid fee invoice left `fee_status` at `"unpaid"` forever.
 *     No payment could ever clear it — the invoice was void, so no webhook was
 *     coming — and the lead's booking page offered no slots, permanently.
 *   - A refund could not re-close the gate, because nothing wrote the enum
 *     back.
 *
 * Reading the ledger fixes both without a special case for either: a voided
 * invoice has no outstanding instalment, and a reversal is a negative row that
 * lowers `netPaid` the moment it lands.
 *
 * The threshold is the whole fee, the deposit, or nothing, depending on the
 * firm's schedule. The "nothing" case was described here from the beginning and
 * never implemented: `after_consultation` writes no instalments, so it fell
 * through to the whole-fee branch and its leads were asked to pay before they
 * could pick a time — the exact opposite of the setting they had chosen, and
 * with an invoice that is deliberately never emailed until the call is done.
 *
 * Distinct from `consultationFeeUnsettled`, which asks whether the money has
 * actually arrived. The two agree on every schedule except this one, where
 * "you may book" and "we have been paid" are deliberately different questions.
 */
export const consultationPaymentOutstanding = async (
  organizationId: string,
  consultation: { invoiceId: string | null; feeStatus: string },
): Promise<boolean> => {
  // Predates invoicing. The legacy flag is all there is, so trust it.
  if (!consultation.invoiceId) return consultation.feeStatus === "unpaid";

  // Nothing is due before the consultation happens, so the gate is open from
  // the start. Read before the invoice: there is no figure to compare against.
  const [settings] = await db
    .select({ feeSchedule: consultationSettings.feeSchedule })
    .from(consultationSettings)
    .where(eq(consultationSettings.organizationId, organizationId))
    .limit(1);

  if (settings?.feeSchedule === "after_consultation") return false;

  return consultationFeeUnsettled(organizationId, consultation);
};

/**
 * Is this consultation's fee still short of what has been collected?
 *
 * The settlement question, as opposed to the booking-gate question above. On
 * `full_upfront` and `partial_upfront` the two coincide — clearing the gate IS
 * paying what was due — so this carries the threshold and the gate defers to
 * it. On `after_consultation` they part company: the gate opens before any
 * money exists, and reusing it to decide settlement would mark a $300 fee paid
 * the moment a $1 payment landed.
 *
 * `partial_upfront` settles at the DEPOSIT, not the total, so a lead who has
 * cleared the gate is not simultaneously recorded as owing the consultation.
 */
export const consultationFeeUnsettled = async (
  organizationId: string,
  consultation: { invoiceId: string | null; feeStatus: string },
): Promise<boolean> => {
  if (!consultation.invoiceId) return consultation.feeStatus === "unpaid";

  const [invoice] = await db
    .select({ status: invoices.status, totalAmount: invoices.totalAmount })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, consultation.invoiceId),
      ),
    )
    .limit(1);

  // The link points at nothing, or at an invoice the firm has withdrawn. Either
  // way there is no debt to hold the booking against.
  if (!invoice) return consultation.feeStatus === "unpaid";
  if (invoice.status === "void") return false;

  const netPaid = await netPaidOnInvoice(organizationId, consultation.invoiceId);

  // A deposit schedule is the only case where part of the total is enough. The
  // first instalment IS the deposit — `setSchedule` renumbers into due-date
  // order, so sequence 1 is always the earliest.
  const [deposit] = await db
    .select({ amount: invoiceInstalments.amount })
    .from(invoiceInstalments)
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        eq(invoiceInstalments.invoiceId, consultation.invoiceId),
      ),
    )
    .orderBy(asc(invoiceInstalments.sequence))
    .limit(1);

  const required = deposit ? num(deposit.amount) : num(invoice.totalAmount);

  // Half a cent, the same tolerance the payment split and schedule balance
  // checks use, so a rounded deposit paid exactly is not one cent short.
  return netPaid < required - 0.005;
};

/**
 * Is a LIVE consultation billed by this invoice?
 *
 * The question behind refusing a Finance refund or void. The refusal exists so
 * money cannot be sent back while a booking is still standing: cancelling is
 * the one act that also releases the calendar slot, revokes the booking link
 * and tells the client, and a bare refund does none of it.
 *
 * Once the consultation is terminal — cancelled, completed or a no-show — all
 * of that has already happened, so the reason evaporates. Refusing then buys
 * nothing and costs the only remaining way to return the client's money: a
 * cancellation whose refund leg failed at the processor cannot be re-run
 * (`cancelConsultation` refuses a cancelled consultation), so Finance is the
 * last door.
 */
export const hasLiveConsultation = async (
  organizationId: string,
  invoiceId: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: consultations.id })
    .from(consultations)
    .where(
      and(
        eq(consultations.organizationId, organizationId),
        eq(consultations.invoiceId, invoiceId),
        inArray(consultations.status, [...LIVE_CONSULTATION_STATUSES]),
      ),
    )
    .limit(1);

  return Boolean(row);
};
