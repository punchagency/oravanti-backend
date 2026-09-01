import { and, eq, sql } from "drizzle-orm";
import { db, systemDb } from "../../db/client";
import { feeAgreements } from "../../db/schema/fee-agreements";
import { invoiceInstalments } from "../../db/schema/invoice-instalments";
import { invoicePayments } from "../../db/schema/invoice-payments";
import { invoices } from "../../db/schema/invoices";
import { createModuleLogger } from "../../lib/logging/log";
import { systemAccess } from "./account-access";
import { clearingPolicyFor, countsTowardCaseOpening } from "./clearing-policy";
import { deliveryEvidence, sendSystemInvoice } from "./deliveries.service";
import type { ScheduleRow } from "./instalments";
import { agingOverDues } from "./dues";
import { create, issueInvoice, type CreateInvoiceLine } from "./invoices.service";
import { num, toMoney } from "./money";
import { amountDueNow } from "./payment-links.service";
import { settleByAttestation } from "./payments.service";
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
  /**
   * The agreement's own practice area, not the lead's. Passed in rather than
   * looked up so the invoice is attributed to what the client actually signed:
   * revenue-by-practice-area must not move because someone re-classified the
   * lead afterwards. NOT NULL on the agreement, so there is nothing to guard.
   */
  practiceAreaId: string;
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
    practiceAreaId: input.practiceAreaId,
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
 * Put a signed agreement's invoice in front of the client, however the firm
 * agreed to collect.
 *
 * Wrappers rather than letting `leads` import `deliveries`/`payments` directly.
 * Those take an `AccountAccess` and `leads` has no concept of one, so a direct
 * import invites handing `accessForRequest()` to a system path that needs
 * `systemAccess()` for trust lines — a fee agreement's government fees are
 * exactly that (see `account-access.ts`). Wrappers make the mistake
 * unreachable, and keep the logic somewhere `12-finance` can reach it.
 *
 * **Never leaves the invoice a draft**, whichever way it goes. Drafts are
 * excluded from countable invoices and the invoice edit dialog is client-shaped,
 * so a lead's draft invoice is a dead end — which is precisely how the
 * fee-agreement gate came to pass unconditionally. `raiseConsultationInvoice`
 * learned this first; this follows it.
 */
export const sendFeeAgreementInvoice = (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
) => sendSystemInvoice(organizationId, invoiceId, actorStaffId);

export const issueFeeAgreementInvoice = (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
  reason: string,
) => issueInvoice(organizationId, invoiceId, reason, actorStaffId);

/**
 * Record that staff say the agreement's upfront payment arrived.
 *
 * The case-opening override. Sends the invoice first when it is still a draft,
 * because `recordPayment` refuses a draft and the gate refuses an undelivered
 * invoice — see `settleByAttestation`, which carries the reasoning.
 */
export const settleFeeAgreementInvoice = (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
) => settleByAttestation(organizationId, invoiceId, actorStaffId);

export type FeeAgreementInvoiceSummary = {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  total: number;
  amountPaid: number;
  balanceDue: number;
  /** What is being asked for now — the next unpaid instalment, or the balance. */
  amountDueNow: number;
  dueDate: string;
  /**
   * Whether the client has actually been sent this bill.
   *
   * `not_attempted` is the honest state of an agreement whose timing is
   * `pay_in_person`, and of everything raised before sending existed. `failed`
   * is the one the tracker has to surface loudly: it is the state in which the
   * case-opening gate blocks, and the fix — resend — is a click away in Finance.
   */
  delivery: "sent" | "failed" | "not_attempted";
  /** Whether this invoice currently satisfies the case-opening gate. */
  satisfiesGate: boolean;
};

/**
 * The money half of the fee-agreement card, in one read.
 *
 * The tracker showed no money at all beyond a "Mark payment received" button,
 * because there was nothing to show — the invoice was a draft nobody sent. Now
 * that it is real, staff need to see what was billed, whether it reached the
 * client, and what is still owed, without leaving the lead for the finance tab.
 */
export const feeAgreementInvoiceSummary = async (
  organizationId: string,
  invoiceId: string | null,
): Promise<FeeAgreementInvoiceSummary | null> => {
  if (!invoiceId) return null;

  const [invoice] = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      totalAmount: invoices.totalAmount,
      amountPaid: invoices.amountPaid,
      balanceDue: invoices.balanceDue,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!invoice) return null;

  const evidence = await deliveryEvidence(organizationId, invoiceId);

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    total: num(invoice.totalAmount),
    amountPaid: num(invoice.amountPaid),
    balanceDue: num(invoice.balanceDue),
    amountDueNow: await amountDueNow(
      organizationId,
      invoiceId,
      num(invoice.amountPaid),
      num(invoice.balanceDue),
    ),
    dueDate: invoice.dueDate,
    delivery:
      evidence.succeeded > 0
        ? "sent"
        : evidence.attempts > 0
          ? "failed"
          : "not_attempted",
    satisfiesGate: await feeInvoiceSatisfied(organizationId, invoiceId),
  };
};

/**
 * What this invoice must have collected before a case may open.
 *
 * The first instalment when the agreement is on a plan, the full total when it
 * is not. A firm that agrees a deposit plus three monthly payments opens the
 * case on the deposit — waiting for the whole plan would make offering one
 * pointless — and a missed instalment later does not close the case again; this
 * is only consulted at open time.
 *
 * Replaces an "is anything past due?" test that had a hole in it. On
 * `pay_in_full` there is no schedule, so nothing is past due until the header
 * date falls — which let a $1 payment against a $2,400 retainer open a case for
 * the whole 14-day terms window. Stated as a threshold, `pay_in_full` has no
 * deposit and its first instalment *is* the total, which is the answer the firm
 * meant.
 *
 * Mirrors `consultationFeeUnsettled` deliberately, half-cent tolerance included:
 * both answer "have we been paid enough to proceed?" and they should not drift.
 */
const requiredBeforeOpening = async (
  organizationId: string,
  invoiceId: string,
  totalAmount: number,
): Promise<number> => {
  const [first] = await systemDb
    .select({ amount: invoiceInstalments.amount })
    .from(invoiceInstalments)
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        eq(invoiceInstalments.invoiceId, invoiceId),
      ),
    )
    .orderBy(invoiceInstalments.sequence)
    .limit(1);

  return first ? num(first.amount) : totalAmount;
};

/**
 * Is the fee-agreement invoice paid up enough to open the case?
 *
 * "Nothing overdue, and enough money that counts." A firm that agrees a deposit
 * plus three monthly payments opens the case on the deposit — waiting for the
 * whole plan would make offering one pointless. A missed instalment later does
 * not close the case again; this is only consulted at open time.
 *
 * ## What counts
 *
 * It used to be `amount_paid > 0`, which asked only whether money had been
 * *reported*. The spike measured a real card payment sitting at `PENDING` with
 * `canVoid: true, settledOn: null`, so a case opened on money that could still
 * be pulled from the batch — and on ACH that window is days long and ends in a
 * possible return.
 *
 * It now sums only the rows the firm's `payment_clearing_policy` says count.
 * The default, `ach_only`, opens on a card at once and waits for ACH to clear,
 * because the risks are not symmetric: an ACH return is routine and arrives
 * within days, whereas a card is more likely to be disputed months later as a
 * chargeback, which no gate can prevent.
 *
 * Note the deliberate split from `invoices.amount_paid`, which stays gross of
 * settlement. A client who has paid is paid; whether the funds have cleared is
 * the firm's cashflow question, not the client's obligation. This is the one
 * place that asks, and it asks explicitly.
 *
 * Returns true when there is no invoice at all: an agreement that bills nothing
 * upfront has nothing to satisfy.
 *
 * ## The draft branch
 *
 * A draft used to pass unconditionally, on the reasoning that an invoice which
 * was never sent is one the client was never asked to pay. The reasoning was
 * sound and the conclusion was still wrong, because at the time NOTHING sent a
 * fee-agreement invoice — so every invoice was a draft, and this gate passed
 * unconditionally instead. Raising invoices had removed the check it was meant
 * to enforce.
 *
 * It now distinguishes absence of evidence from evidence of failure:
 *
 *   - zero send attempts  → pass. Every agreement predating invoicing is here,
 *                           and this is the literal truth of the old comment.
 *   - attempts, none sent → BLOCK. Positive evidence the client was never
 *                           billed. Visible as a `failed` delivery row with a
 *                           reason, fixable by resending, and overridable
 *                           through `settleFeeAgreementInvoice`.
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
  // `refunded` is deliberately NOT here. Void means the firm decided not to
  // charge, so nothing is owed and nothing should block. Refunded means the
  // client paid and got the money back — they have not paid, so the case should
  // stay shut. Falling through to the counted-money test below gets that right
  // on its own: the reversal nets the payment out and `counted` is zero.
  if (invoice.status === "draft") {
    const { attempts, succeeded } = await deliveryEvidence(
      organizationId,
      invoiceId,
    );
    // Delivered and somehow still a draft: the client has the bill, so the
    // absence of payment is the answer, not the absence of a demand.
    if (succeeded > 0) return false;
    return attempts === 0;
  }

  // Deliberately BEFORE any `paid` short-circuit. `status` is derived from
  // `amount_paid`, which is gross of settlement, so an invoice paid in full by a
  // card that has not deposited reads as "paid" — and returning true on that
  // would wave through exactly the money this gate exists to wait for, under
  // every policy including all_payments.
  const counted = await countedPaid(organizationId, invoiceId);
  const required = await requiredBeforeOpening(
    organizationId,
    invoiceId,
    num(invoice.totalAmount),
  );

  // Half a cent, matching `consultationFeeUnsettled`, so an instalment that
  // divides badly cannot hold a case shut over a rounding artefact the client
  // has no way to pay off.
  if (counted < required - 0.005) return false;

  // Cleared the threshold, and still nothing late.
  //
  // Both conditions, not either. The threshold alone would open a case for a
  // client who paid a deposit and then went delinquent before anyone got round
  // to opening it — this is only consulted at open time, so "they are behind
  // right now" is exactly the question being asked. The past-due test alone was
  // the previous behaviour and had the `pay_in_full` hole above.
  const overdue = await agingOverDues(
    organizationId,
    await firmToday(organizationId),
    eq(invoices.id, invoiceId),
  );
  return num(overdue.pastDue) <= 0;
};

/**
 * Money on this invoice that counts toward opening a case.
 *
 * Net of reversals, because reversal rows are negative and always settled — a
 * returned payment reduces this the moment we hear about it, under every
 * policy.
 */
const countedPaid = async (
  organizationId: string,
  invoiceId: string,
): Promise<number> => {
  const policy = await clearingPolicyFor(organizationId);

  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${invoicePayments.amount}), 0)`,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.invoiceId, invoiceId),
        countsTowardCaseOpening(policy),
      ),
    );

  return num(row?.total);
};
