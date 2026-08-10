import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { organization } from "../../db/schema/auth-schema";
import { clients } from "../../db/schema/clients";
import { invoiceFollowups } from "../../db/schema/invoice-followups";
import { invoicePayments } from "../../db/schema/invoice-payments";
import { invoices, type PaymentMethod } from "../../db/schema/invoices";
import { withTransaction } from "../../db/transaction-context";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { emailService } from "../../utils/email/email.service";
import { logCaseEvent } from "../cases/case-events.service";
import { requireTrustWrite } from "./account-access";
import { canChaseInvoice } from "./deliveries.service";
import { agingOverDues } from "./dues";
import { logFinanceEvent } from "./finance-events.service";
import { getById } from "./invoices.service";
import { money, num, proRateSplit, toMoney } from "./money";
import { dueBy, firmToday } from "./status";
import { recalculateInvoiceTotals } from "./totals";
import type { AccountAccess, FollowupChannelInput } from "./types";

export type RecordPaymentInput = {
  amount: number;
  /** Optional explicit split; pro-rated from the outstanding balance if absent. */
  amountOperating?: number;
  amountTrust?: number;
  paymentDate: string;
  method: PaymentMethod;
  reference?: string;
  notes?: string;
};

export const recordPayment = async (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
  access: AccountAccess,
  input: RecordPaymentInput,
) => {
  const [invoice] = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      caseId: invoices.caseId,
      clientId: invoices.clientId,
      subtotalOperating: invoices.subtotalOperating,
      subtotalTrust: invoices.subtotalTrust,
      amountPaid: invoices.amountPaid,
    })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!invoice) throw new NotFoundError("Invoice not found");
  if (invoice.status === "void") {
    throw new BadRequestError("A voided invoice cannot receive a payment");
  }
  if (invoice.status === "draft") {
    throw new BadRequestError("Send the invoice before recording a payment");
  }

  // What is still owed on each side, so the pro-rata default apportions against
  // the remaining balance rather than the original totals.
  const paid = await sumPaidBySide(organizationId, invoiceId);

  const operatingOutstanding = Math.max(
    toMoney(num(invoice.subtotalOperating) - paid.operating),
    0,
  );
  const trustOutstanding = Math.max(
    toMoney(num(invoice.subtotalTrust) - paid.trust),
    0,
  );

  const explicit =
    input.amountOperating != null || input.amountTrust != null;

  const split = explicit
    ? {
        operating: toMoney(input.amountOperating ?? 0),
        trust: toMoney(input.amountTrust ?? 0),
      }
    : proRateSplit(input.amount, operatingOutstanding, trustOutstanding);

  if (explicit) {
    const sum = toMoney(split.operating + split.trust);
    if (Math.abs(sum - toMoney(input.amount)) >= 0.005) {
      throw new BadRequestError(
        "Operating and trust amounts must sum to the payment amount",
      );
    }
  }

  // Touching trust money is a write, so it needs full access — not merely the
  // read grant that lets someone see the figures.
  if (split.trust > 0) requireTrustWrite(access);

  return withTransaction(db, async () => {
    await db.insert(invoicePayments).values({
      organizationId,
      invoiceId,
      amount: money(input.amount),
      amountOperating: money(split.operating),
      amountTrust: money(split.trust),
      paymentDate: input.paymentDate,
      method: input.method,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      recordedById: actorStaffId,
    });

    const totals = await recalculateInvoiceTotals(organizationId, invoiceId);
    const fullySettled = totals.status === "paid";

    await logFinanceEvent({
      organizationId,
      eventType: fullySettled ? "invoice_paid" : "invoice_partially_paid",
      title: fullySettled
        ? `${invoice.invoiceNumber} — paid`
        : `${invoice.invoiceNumber} — partial payment`,
      description: input.reference ? `Ref ${input.reference}` : null,
      amount: input.amount,
      paymentMethod: input.method,
      invoiceId,
      caseId: invoice.caseId,
      clientId: invoice.clientId,
      actorId: actorStaffId,
      metadata: {
        amountOperating: split.operating,
        amountTrust: split.trust,
        splitSource: explicit ? "explicit" : "pro_rata",
      },
    });

    if (invoice.caseId) {
      await logCaseEvent({
        organizationId,
        caseId: invoice.caseId,
        eventType: "case_payment_received",
        title: `Payment of ${input.amount.toFixed(2)} received`,
        description: `Invoice ${invoice.invoiceNumber}`,
        actorId: actorStaffId,
      });
    }

    return getById(organizationId, invoiceId, access);
  });
};

/** Paid-to-date per side, so the pro-rata default uses live outstandings. */
const sumPaidBySide = async (
  organizationId: string,
  invoiceId: string,
): Promise<{ operating: number; trust: number }> => {
  const [row] = await db
    .select({
      operating: sql<string>`coalesce(sum(${invoicePayments.amountOperating}), 0)`,
      trust: sql<string>`coalesce(sum(${invoicePayments.amountTrust}), 0)`,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    );

  return { operating: num(row?.operating), trust: num(row?.trust) };
};

// ── Follow-ups ───────────────────────────────────────────────────────────────

export type SendFollowUpInput = {
  message: string;
  channel: FollowupChannelInput;
};

const followUpTemplate = (opts: {
  firmName: string;
  message: string;
}): string => `
  <div style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #1a1a1a;">
    <p style="white-space: pre-wrap; margin: 0 0 16px;">${escapeHtml(opts.message)}</p>
    <p style="margin: 24px 0 0; color: #666; font-size: 13px;">${escapeHtml(opts.firmName)}</p>
  </div>
`;

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const sendFollowUp = async (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
  input: SendFollowUpInput,
) => {
  const [row] = await db
    .select({
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      caseId: invoices.caseId,
      clientId: invoices.clientId,
      balanceDue: invoices.balanceDue,
      amountPaid: invoices.amountPaid,
      // Not `due_date`: on a scheduled invoice the header is the FINAL
      // instalment's date, so chasing against it would report a debt that is
      // not late yet — or, once the last instalment passes, one that is far
      // later than any single missed payment.
      dueDate: dueBy,
      clientEmail: clients.email,
      clientPhone: clients.phone,
      clientName: clients.displayName,
      firmName: organization.name,
    })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .leftJoin(organization, eq(organization.id, invoices.organizationId))
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  if (!row) throw new NotFoundError("Invoice not found");
  if (row.status === "void") {
    throw new BadRequestError("A voided invoice cannot be followed up");
  }
  if (row.status === "paid") {
    throw new BadRequestError("This invoice is already paid");
  }
  // Chasing someone for an invoice they were never sent is the failure mode
  // this whole delivery flow exists to prevent.
  if (!(await canChaseInvoice(organizationId, invoiceId))) {
    throw new BadRequestError(
      "This invoice has not reached the client — the last delivery attempt failed. Resend it first.",
    );
  }

  const wantsEmail = input.channel === "email" || input.channel === "both";
  const wantsSms = input.channel === "sms" || input.channel === "both";

  if (wantsEmail && !row.clientEmail) {
    throw new BadRequestError("This client has no email address on file");
  }
  if (wantsSms && !row.clientPhone) {
    throw new BadRequestError("This client has no phone number on file");
  }

  let emailDelivered = false;
  if (wantsEmail && row.clientEmail) {
    // A send failure must not lose the record of the attempt, so the row is
    // written either way with the real outcome in `emailDelivered`.
    try {
      await emailService.sendEmail({
        to: row.clientEmail,
        subject: `Payment reminder — invoice ${row.invoiceNumber}`,
        html: followUpTemplate({
          firmName: row.firmName ?? "Your legal team",
          message: input.message,
        }),
      });
      emailDelivered = true;
    } catch (err) {
      console.error(
        `[finance] follow-up email failed for invoice ${row.invoiceNumber}:`,
        err,
      );
    }
  }

  if (wantsSms && row.clientPhone) {
    // No SMS provider is wired anywhere in this repo yet; every other flow logs
    // the intent the same way. `smsDelivered` stays false rather than claiming
    // a delivery that did not happen.
    console.log(
      `[sms-stub] payment follow-up to ${row.clientPhone} for invoice ${row.invoiceNumber}`,
    );
  }

  const [followup] = await db
    .insert(invoiceFollowups)
    .values({
      organizationId,
      invoiceId,
      channel: input.channel,
      message: input.message,
      sentToEmail: wantsEmail ? row.clientEmail : null,
      sentToPhone: wantsSms ? row.clientPhone : null,
      emailDelivered,
      smsDelivered: false,
      sentById: actorStaffId,
    })
    .returning();

  const today = await firmToday(organizationId);
  const daysOverdue = Math.max(
    Math.floor(
      (Date.parse(`${today}T00:00:00Z`) -
        Date.parse(`${row.dueDate}T00:00:00Z`)) /
        86_400_000,
    ),
    0,
  );

  // The amount actually late, not the whole balance. On a plan the client may
  // owe $4,000 in total and be $1,000 behind; recording the larger figure would
  // leave a permanently wrong audit entry for a chase about the smaller one.
  const overdueSlices = await agingOverDues(
    organizationId,
    today,
    eq(invoices.id, invoiceId),
  );
  const overdueAmount = num(overdueSlices.pastDue);

  await logFinanceEvent({
    organizationId,
    eventType: "payment_followup_sent",
    title: `${row.invoiceNumber} — follow-up sent`,
    description:
      daysOverdue > 0
        ? `${daysOverdue} day(s) overdue · ${input.channel}`
        : `Sent via ${input.channel}`,
    amount: overdueAmount > 0 ? overdueAmount : num(row.balanceDue),
    invoiceId,
    caseId: row.caseId,
    clientId: row.clientId,
    actorId: actorStaffId,
  });

  return {
    id: followup!.id,
    channel: followup!.channel,
    emailDelivered,
    smsDelivered: false,
    sentAt: followup!.sentAt,
    daysOverdue,
    /** What is actually late — the whole balance only on an unscheduled invoice. */
    overdueAmount,
  };
};
