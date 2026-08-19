import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { organization } from "../../db/schema/auth-schema";
import { clients } from "../../db/schema/clients";
import { leads } from "../../db/schema/leads";
import { invoiceFollowups } from "../../db/schema/invoice-followups";
import { invoicePayments } from "../../db/schema/invoice-payments";
import { invoices, type PaymentMethod } from "../../db/schema/invoices";
import { withTransaction } from "../../db/transaction-context";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { emailService } from "../../utils/email/email.service";
import { createModuleLogger } from "../../lib/logging/log";

const log = createModuleLogger("finance.payments");
import { logCaseEvent } from "../cases/case-events.service";
import { requireTrustWrite } from "./account-access";
import { canChaseInvoice } from "./deliveries.service";
import { agingOverDues } from "./dues";
import { logFinanceEvent } from "./finance-events.service";
import { getById } from "./invoices.service";
import { money, num, toMoney, trustFirstSplit } from "./money";
import { onClient, onLead, partyEmail, partyName, partyPhone } from "./party";
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
  /**
   * Set only by a provider webhook. The unique index on
   * (provider, provider_reference) is what makes a redelivered event a
   * constraint violation instead of the same money recorded twice.
   */
  provider?: string;
  providerReference?: string;
  /**
   * One row per credited account, for provider payments.
   *
   * Confido emits one transaction per bank account it credits, each with its
   * own id, so a payment touching both accounts arrives as two events. Given
   * legs, this writes one single-sided row each rather than one combined row:
   * `sum(amount)` stays equal to the money received, which is the invariant
   * `invoices.amount_paid` folds on, and each row can carry its own
   * `providerReference` so the replay guard still works per transaction.
   *
   * Mutually exclusive with `amountOperating`/`amountTrust`.
   */
  legs?: PaymentLeg[];
};

export type PaymentLeg = {
  account: "operating" | "trust_iolta";
  amount: number;
  /** The provider's id for THIS leg — one transaction, one reference. */
  providerReference?: string;
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
    : trustFirstSplit(input.amount, operatingOutstanding, trustOutstanding);

  if (explicit) {
    const sum = toMoney(split.operating + split.trust);
    if (Math.abs(sum - toMoney(input.amount)) >= 0.005) {
      throw new BadRequestError(
        "Operating and trust amounts must sum to the payment amount",
      );
    }
  }

  // What actually lands in each account. With provider legs that is the legs
  // themselves, not the fallback split — checking the wrong one would gate
  // trust access on a number this payment never uses.
  const effective = input.legs?.length
    ? {
        operating: toMoney(
          input.legs
            .filter((l) => l.account === "operating")
            .reduce((sum, l) => sum + l.amount, 0),
        ),
        trust: toMoney(
          input.legs
            .filter((l) => l.account === "trust_iolta")
            .reduce((sum, l) => sum + l.amount, 0),
        ),
      }
    : split;

  // Touching trust money is a write, so it needs full access — not merely the
  // read grant that lets someone see the figures. Asked once for the whole
  // payment, not per leg.
  if (effective.trust > 0) requireTrustWrite(access);

  // One row per credited account when the provider gave us legs, one combined
  // row otherwise. A zero leg produces NO row: `invoice_payments_amount_positive`
  // rejects a 0.00 amount, and a row for money that did not move would be a lie
  // anyway.
  const rows = (input.legs ?? [])
    .filter((leg) => toMoney(leg.amount) > 0)
    .map((leg) => ({
      amount: money(leg.amount),
      amountOperating: money(leg.account === "operating" ? leg.amount : 0),
      amountTrust: money(leg.account === "trust_iolta" ? leg.amount : 0),
      providerReference: leg.providerReference ?? input.providerReference ?? null,
    }));

  const toInsert = rows.length
    ? rows
    : [
        {
          amount: money(input.amount),
          amountOperating: money(split.operating),
          amountTrust: money(split.trust),
          providerReference: input.providerReference ?? null,
        },
      ];

  return withTransaction(db, async () => {
    for (const row of toInsert) {
      await db.insert(invoicePayments).values({
        organizationId,
        invoiceId,
        ...row,
        paymentDate: input.paymentDate,
        method: input.method,
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        provider: input.provider ?? null,
        recordedById: actorStaffId,
      });
    }

    const totals = await recalculateInvoiceTotals(organizationId, invoiceId);
    const fullySettled = totals.status === "paid";

    await logFinanceEvent({
      organizationId,
      action: fullySettled ? "finance.invoice_paid" : "finance.invoice_partially_paid",
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
        amountOperating: effective.operating,
        amountTrust: effective.trust,
        splitSource: input.legs?.length
          ? "provider_legs"
          : explicit
            ? "explicit"
            : "trust_first",
      },
    });

    if (invoice.caseId) {
      await logCaseEvent({
        organizationId,
        caseId: invoice.caseId,
        action: "case.payment_received",
        
        summary: `Invoice ${invoice.invoiceNumber}`,
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
      clientEmail: partyEmail,
      clientPhone: partyPhone,
      clientName: partyName,
      firmName: organization.name,
    })
    .from(invoices)
    .leftJoin(clients, onClient)
    .leftJoin(leads, onLead)
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
      log.failure("payment.followup_email_failed", err, { invoiceNumber: row.invoiceNumber });
    }
  }

  if (wantsSms && row.clientPhone) {
    // No SMS provider is wired anywhere in this repo yet; every other flow logs
    // the intent the same way. `smsDelivered` stays false rather than claiming
    // a delivery that did not happen.
    log.debug("sms.followup_stub", { phone: row.clientPhone, invoiceNumber: row.invoiceNumber });
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
    action: "finance.payment_followup_sent",
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
