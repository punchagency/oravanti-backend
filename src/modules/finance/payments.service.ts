import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { organization } from "../../db/schema/auth-schema";
import { clients } from "../../db/schema/clients";
import { leads } from "../../db/schema/leads";
import { invoiceFollowups } from "../../db/schema/invoice-followups";
import { invoicePayments } from "../../db/schema/invoice-payments";
import { invoices, type PaymentMethod } from "../../db/schema/invoices";
import { withTransaction } from "../../db/transaction-context";
import { env } from "../../config/env";
import { notify } from "../../notifications/notification.service";
import { staffRecipientsForFirm } from "../../notifications/recipients";
import { dispatchNotification } from "../../queue/workers/notification.worker";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { logCaseEvent } from "../cases/case-events.service";
import { requireTrustWrite } from "./account-access";
import { canChaseInvoice } from "./deliveries.service";
import { agingOverDues } from "./dues";
import { logFinanceEvent } from "./finance-events.service";
import { getById } from "./invoices.service";
import { money, num, proRateSplit, toMoney } from "./money";
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
      provider: input.provider ?? null,
      providerReference: input.providerReference ?? null,
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

    /**
     * Both halves of a payment landing. Until now this moment was entirely
     * silent: money arrived, the ledger moved, and neither the payer nor the
     * firm was told — whether recorded by hand or by the payment webhook.
     *
     * Deliberately two events. The receipt is transactional, because someone
     * who paid is owed one no matter what the firm has switched off; the staff
     * alert is preference-gated, because it is an alert. Modelling them as one
     * would force a choice between spamming staff and withholding receipts.
     *
     * Fire-and-forget, and outside the caller's error path: a notification
     * failure must never roll back a recorded payment.
     */
    void notifyPaymentRecorded({
      organizationId,
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      amount: input.amount,
      paymentDate: input.paymentDate,
      fullySettled,
      actorStaffId,
    }).catch((error: unknown) =>
      console.error("[finance] payment notify failed", error),
    );

    return getById(organizationId, invoiceId, access);
  });
};

/**
 * Receipt to the payer, alert to the firm.
 *
 * Re-reads the party rather than taking it from the caller because
 * `recordPayment` selects only what the ledger maths needs, and the payer of an
 * invoice may be a lead or a client (see ./party) — which determines whose
 * consent and suppression state applies.
 */
const notifyPaymentRecorded = async (args: {
  organizationId: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  paymentDate: string;
  fullySettled: boolean;
  actorStaffId: string | null;
}): Promise<void> => {
  const [row] = await db
    .select({
      clientId: invoices.clientId,
      leadId: invoices.leadId,
      caseId: invoices.caseId,
      balanceDue: invoices.balanceDue,
      partyName: partyName,
    })
    .from(invoices)
    .leftJoin(clients, onClient)
    .leftJoin(leads, onLead)
    .where(
      and(
        eq(invoices.organizationId, args.organizationId),
        eq(invoices.id, args.invoiceId),
      ),
    )
    .limit(1);

  if (!row) return;

  const amount = `$${money(args.amount)}`;

  await notify({
    organizationId: args.organizationId,
    event: "payment_receipt_sent",
    recipients: [
      row.clientId
        ? { type: "client", id: row.clientId }
        : { type: "lead", id: row.leadId! },
    ],
    context: {
      amount,
      invoiceNumber: args.invoiceNumber,
      paidAt: args.paymentDate,
      // Omitted once settled: "remaining balance: $0.00" reads as a demand.
      ...(args.fullySettled
        ? {}
        : { balance: `$${money(num(row.balanceDue))}` }),
    },
    scenario: {
      invoiceId: args.invoiceId,
      clientId: row.clientId ?? undefined,
      caseId: row.caseId ?? undefined,
    },
    actorStaffId: args.actorStaffId,
    // Not keyed on the invoice: instalment plans pay the same invoice several
    // times, and each payment earns its own receipt.
    dedupeKey: `payment-receipt-${args.invoiceId}-${args.paymentDate}-${amount}`,
  });

  await notify({
    organizationId: args.organizationId,
    event: "payment_received_staff",
    recipients: await staffRecipientsForFirm(args.organizationId),
    context: {
      amount,
      invoiceNumber: args.invoiceNumber,
      clientName: row.partyName,
      link: `${env.FRONTEND_APP_URL}/admin/finance/invoices/${args.invoiceId}`,
    },
    scenario: {
      invoiceId: args.invoiceId,
      clientId: row.clientId ?? undefined,
      caseId: row.caseId ?? undefined,
    },
    actorStaffId: args.actorStaffId,
    dedupeKey: `payment-staff-${args.invoiceId}-${args.paymentDate}-${amount}`,
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

// The follow-up template moved to src/notifications/templates/finance.templates.ts,
// along with the local escapeHtml it used — the shared renderer escapes every
// interpolation by default rather than relying on each template remembering to.

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
      // An invoice bills a lead OR a client, never both — see ./party. The
      // notification needs whichever one it is, to resolve consent against the
      // row the phone number came from.
      leadId: invoices.leadId,
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

  const channels = [
    ...(wantsEmail ? (["email"] as const) : []),
    ...(wantsSms ? (["sms"] as const) : []),
  ];

  /**
   * Dispatched inline rather than left to the worker.
   *
   * Every other caller of notify() is fire-and-forget, but this one is a staff
   * member pressing "send" and then reading an audit row that claims what
   * happened. `invoice_followups.emailDelivered` has always recorded the real
   * outcome; queueing would force it to record an intention instead, and the
   * one column whose job is to not overstate a delivery would start doing
   * exactly that.
   */
  const { notifications: queued } = await notify({
    organizationId,
    event: "payment_followup",
    recipients: [
      row.clientId
        ? { type: "client", id: row.clientId }
        : { type: "lead", id: row.leadId! },
    ],
    context: {
      message: input.message,
      invoiceNumber: row.invoiceNumber,
      // Formatted here, never in the template: the context is persisted as
      // jsonb and re-rendered later, so a raw number would invite a second,
      // divergent notion of what an amount looks like.
      amount: `$${money(num(row.balanceDue))}`,
      dueDate: row.dueDate,
    },
    channels: [...channels],
    scenario: { invoiceId, clientId: row.clientId ?? undefined },
    actorStaffId,
  });

  let emailDelivered = false;
  let smsDelivered = false;

  for (const notification of queued) {
    // A skipped row already carries its reason — consent, suppression, the
    // firm's SMS switch. Nothing to attempt.
    if (notification.status === "skipped") continue;

    const ok = await dispatchNotification(notification.id).catch((err: unknown) => {
      console.error(
        `[finance] follow-up ${notification.channel} failed for invoice ${row.invoiceNumber}:`,
        err,
      );
      return false;
    });

    if (notification.channel === "email") emailDelivered = ok;
    if (notification.channel === "sms") smsDelivered = ok;
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
      smsDelivered,
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
