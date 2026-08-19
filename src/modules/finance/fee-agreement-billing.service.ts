import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { feeAgreements } from "../../db/schema/fee-agreements";
import { invoices } from "../../db/schema/invoices";
import { leads } from "../../db/schema/leads";
import { createModuleLogger } from "../../lib/logging/log";
import { systemAccess } from "./account-access";
import { agingOverDues } from "./dues";
import type { ScheduleRow } from "./instalments";
import { create, type CreateInvoiceLine } from "./invoices.service";
import { num, toMoney } from "./money";
import { firmToday } from "./status";

const log = createModuleLogger("fee-agreement-billing.service");

/**
 * Fee agreements, as invoices.
 *
 * A signed fee agreement recorded payment as `details.paymentReceivedAt` — one
 * ISO string in a JSON blob, with no amount, no method and no date other than
 * "now". It gated case opening and was the only record that the client had paid
 * anything at all.
 *
 * It now raises an invoice at signing, against the LEAD (a client row does not
 * exist yet, and `openCase` — the only thing that creates one — is gated on
 * this very payment).
 */

const addDays = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
};

/** Days a fee-agreement invoice is given when the plan does not say otherwise. */
const TERMS_DAYS = 14;

type DocumentLine = {
  description: string;
  amount: number | null;
  deferred?: boolean;
  kind: "fee" | "government" | "cost";
};

/**
 * Turn the agreement's own fee lines into invoice lines.
 *
 * Only the NON-DEFERRED ones — that is precisely the set the document already
 * sums into `totalDue`, so the invoice and the agreement cannot disagree.
 * Deferred lines are money the firm is advancing or a contingency that has not
 * happened yet; billing them now would be asking for money nobody owes.
 *
 * Government fees are held in trust. That is the whole reason the line `kind`
 * exists: a filing fee is the client's money passing through the firm on its
 * way to an agency, and putting it in the operating account is an IOLTA
 * problem, not a formatting one.
 */
export const linesFromDocument = (
  feeLines: DocumentLine[],
): CreateInvoiceLine[] =>
  feeLines
    .filter((l) => !l.deferred && l.amount != null && l.amount > 0)
    .map((l) => ({
      description: l.description,
      quantity: 1,
      rate: l.amount!,
      account: l.kind === "government" ? ("trust_iolta" as const) : ("operating" as const),
    }));

/**
 * Turn the agreed payment plan into a real instalment schedule.
 *
 * The wizard has always let an attorney promise "three monthly payments of
 * $333.33" without anything checking that against the total — `333.33 × 3` is
 * `999.99`, not `1000`. Rather than import that drift, the plan's SHAPE is
 * honoured (how many payments, starting when) and the amounts are recomputed
 * so they sum exactly, with the remainder on the last instalment.
 *
 * Returns null for `pay_in_full`, which needs no schedule.
 */
export const scheduleFromPlan = (
  total: number,
  plan: "pay_in_full" | "two_payments" | "installments",
  twoPayments: { secondDueDate: string; firstAmount: number } | null,
  instalmentPlan: { numberOfPayments: number; firstPaymentDate: string } | null,
  signedOn: string,
): ScheduleRow[] | null => {
  if (plan === "pay_in_full") return null;

  if (plan === "two_payments" && twoPayments) {
    // The first payment is due at signing by the agreement's own wording. The
    // split the attorney chose is kept; only the second is derived, so the two
    // add up.
    const first = toMoney(Math.min(twoPayments.firstAmount, total));
    const second = toMoney(total - first);
    if (second <= 0) return null;
    return [
      { dueDate: signedOn, amount: first },
      { dueDate: twoPayments.secondDueDate, amount: second },
    ];
  }

  if (plan === "installments" && instalmentPlan) {
    const count = Math.max(1, Math.floor(instalmentPlan.numberOfPayments));
    const each = toMoney(total / count);
    const rows: ScheduleRow[] = [];
    let allocated = 0;
    const [y, m, d] = instalmentPlan.firstPaymentDate.split("-").map(Number);

    for (let i = 0; i < count; i += 1) {
      const amount = i === count - 1 ? toMoney(total - allocated) : each;
      allocated = toMoney(allocated + amount);
      // Monthly, clamped to the end of the month — 31 Jan + 1 month is 28 Feb,
      // and rolling into March would put an instalment out of order.
      const target = new Date(Date.UTC(y!, m! - 1 + i, 1));
      const lastDay = new Date(
        Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
      ).getUTCDate();
      rows.push({
        dueDate: new Date(
          Date.UTC(
            target.getUTCFullYear(),
            target.getUTCMonth(),
            Math.min(d!, lastDay),
          ),
        )
          .toISOString()
          .slice(0, 10),
        amount,
      });
    }
    return rows.every((r) => r.amount > 0) ? rows : null;
  }

  return null;
};

export type FeeAgreementInvoiceInput = {
  agreementId: string;
  leadId: string;
  feeLines: DocumentLine[];
  totalDue: number;
  paymentPlan: "pay_in_full" | "two_payments" | "installments";
  twoPaymentsSchedule: { secondDueDate: string; firstAmount: number } | null;
  installmentSchedule: { numberOfPayments: number; firstPaymentDate: string } | null;
  applyConsultationCredit: boolean;
  consultationFeeAmount: number | null;
};

/**
 * Raise the invoice for a signed fee agreement, if there is anything to bill.
 *
 * Returns null when the agreement asks for nothing upfront — a pure contingency
 * with firm-advanced costs. `create()` refuses an invoice with no lines anyway,
 * and an invoice for zero would be noise in every receivables figure.
 *
 * Note what this closes: a contingency agreement with `client_upfront`
 * government fees has a real `totalDue`, and `feeAgreementPaymentSatisfied`
 * short-circuits on contingency *before* looking at payment. That money was
 * never gated and never invoiced — nothing in the system has ever asked for it.
 */
export const raiseFeeAgreementInvoice = async (
  organizationId: string,
  actorStaffId: string | null,
  input: FeeAgreementInvoiceInput,
): Promise<string | null> => {
  const lines = linesFromDocument(input.feeLines);
  if (lines.length === 0) return null;

  // The consultation fee the client has already paid, credited against what
  // they now owe. The agreement has carried this flag since it was written and
  // never subtracted anything — it was prose in the document and nothing else.
  if (input.applyConsultationCredit && input.consultationFeeAmount) {
    const credit = toMoney(Math.min(input.consultationFeeAmount, input.totalDue));
    if (credit > 0) {
      lines.push({
        description: "Less consultation fee already paid",
        quantity: 1,
        rate: -credit,
        account: "operating",
      });
    }
  }

  const billed = toMoney(lines.reduce((sum, l) => sum + l.quantity * l.rate, 0));
  if (billed <= 0) return null;

  const [lead] = await db
    .select({ practiceAreaId: leads.practiceAreaId })
    .from(leads)
    .where(and(eq(leads.organizationId, organizationId), eq(leads.id, input.leadId)))
    .limit(1);

  if (!lead?.practiceAreaId) return null;

  const today = await firmToday(organizationId);
  const schedule = scheduleFromPlan(
    billed,
    input.paymentPlan,
    input.twoPaymentsSchedule,
    input.installmentSchedule,
    today,
  );

  const invoice = await create(organizationId, actorStaffId, systemAccess(), {
    leadId: input.leadId,
    practiceAreaId: lead.practiceAreaId,
    issueDate: today,
    // With a plan the schedule pins the header date to its final instalment.
    dueDate: addDays(today, TERMS_DAYS),
    status: "draft",
    lineItems: lines,
    timeEntryIds: [],
    ...(schedule ? { instalments: schedule } : {}),
  });

  await db
    .update(feeAgreements)
    .set({ invoiceId: invoice.id, updatedAt: new Date() })
    .where(eq(feeAgreements.id, input.agreementId));

  log.action("fee_agreement.generated", { agreementId: input.agreementId, invoiceId: invoice.id });

  return invoice.id;
};

/**
 * Is the fee-agreement invoice paid up enough to open the case?
 *
 * "Nothing overdue, and something received." A firm that agrees a deposit plus
 * three monthly payments opens the case on the deposit — waiting for the whole
 * plan would make offering one pointless. A missed instalment later does not
 * close the case again; this is only consulted at open time.
 *
 * Returns true when there is no invoice at all: an agreement that bills nothing
 * upfront has nothing to satisfy.
 */
export const feeInvoiceSatisfied = async (
  organizationId: string,
  invoiceId: string | null,
): Promise<boolean> => {
  if (!invoiceId) return true;

  const [invoice] = await db
    .select({
      status: invoices.status,
      amountPaid: invoices.amountPaid,
      totalAmount: invoices.totalAmount,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  // A link pointing at nothing must not block a case indefinitely.
  if (!invoice) return true;
  if (invoice.status === "void") return true;
  if (invoice.status === "paid") return true;
  // Still a draft: it was never sent, so the client has not been asked. Do not
  // hold the case hostage to a billing step the firm has not completed.
  if (invoice.status === "draft") return true;

  if (num(invoice.amountPaid) <= 0) return false;

  const today = await firmToday(organizationId);
  const overdue = await agingOverDues(
    organizationId,
    today,
    eq(invoices.id, invoiceId),
  );
  return num(overdue.pastDue) <= 0;
};
