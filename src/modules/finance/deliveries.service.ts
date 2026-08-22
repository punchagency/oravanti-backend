import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { organization } from "../../db/schema/auth-schema";
import { clients } from "../../db/schema/clients";
import { leads } from "../../db/schema/leads";
import { invoiceDeliveries } from "../../db/schema/invoice-deliveries";
import { invoices } from "../../db/schema/invoices";
import { staff } from "../../db/schema/staff";
import { emailService } from "../../utils/email/email.service";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { storageService } from "../../utils/storage/storage.service";
import { createModuleLogger } from "../../lib/logging/log";

const log = createModuleLogger("finance.deliveries");
import { logCaseEvent } from "../cases/case-events.service";
import { logFinanceEvent } from "./finance-events.service";
import { getById } from "./invoices.service";
import { mintPaymentLink, paymentLinkFor } from "./payment-links.service";
import { paymentsEnabledFor } from "./confido/payments-enabled";
import { onClient, onLead, partyEmail, partyName } from "./party";
import { renderInvoicePdf, type InvoicePdfInput } from "./invoice-pdf";
import type { AccountAccess } from "./types";

/**
 * Sending an invoice to a client, and recording what actually happened.
 *
 * The ordering here is the whole point. An email is an external side effect
 * that cannot be rolled back, so this is deliberately NOT one transaction:
 *
 *   1. archive the exact PDF
 *   2. commit a `pending` delivery row      ← evidence survives a crash
 *   3. send
 *   4. mark the delivery sent/failed, and only on success promote the invoice
 *
 * Doing it the other way — stamp `sentAt`, then send — is what produced the
 * original bug where every invoice claimed a delivery that never happened.
 */

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const money = (n: number): string =>
  `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/**
 * On an invoice with a payment schedule the headline is the FIRST payment, not
 * the total. A client who agreed to pay $4,000 over four months and opens an
 * email demanding $4,000 by a single date will assume the plan was not applied.
 * The total is still shown, below, and the full schedule is in the attachment.
 */
const invoiceEmailTemplate = (opts: {
  clientName: string;
  firmName: string;
  invoiceNumber: string;
  total: number;
  dueDate: string;
  matterReference: string | null;
  instalmentCount: number;
  firstInstalment: { dueDate: string; amount: number } | null;
  /** Null while no payment provider is configured — no button is shown. */
  paymentUrl: string | null;
}): string => {
  const scheduled = opts.instalmentCount > 0 && opts.firstInstalment !== null;

  const rows = scheduled
    ? `
      <tr>
        <td style="padding: 4px 16px 4px 0; color: #666;">First payment</td>
        <td style="padding: 4px 0;"><b>${money(opts.firstInstalment!.amount)}</b></td>
      </tr>
      <tr>
        <td style="padding: 4px 16px 4px 0; color: #666;">Due</td>
        <td style="padding: 4px 0;"><b>${escapeHtml(opts.firstInstalment!.dueDate)}</b></td>
      </tr>
      <tr>
        <td style="padding: 4px 16px 4px 0; color: #666;">Total</td>
        <td style="padding: 4px 0;">${money(opts.total)} over ${opts.instalmentCount} payments</td>
      </tr>`
    : `
      <tr>
        <td style="padding: 4px 16px 4px 0; color: #666;">Amount due</td>
        <td style="padding: 4px 0;"><b>${money(opts.total)}</b></td>
      </tr>
      <tr>
        <td style="padding: 4px 16px 4px 0; color: #666;">Due date</td>
        <td style="padding: 4px 0;"><b>${escapeHtml(opts.dueDate)}</b></td>
      </tr>`;

  return `
  <div style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #1a1a1a;">
    <p style="margin: 0 0 16px;">Dear ${escapeHtml(opts.clientName)},</p>
    <p style="margin: 0 0 16px;">
      Please find attached invoice <b>${escapeHtml(opts.invoiceNumber)}</b>${
        opts.matterReference
          ? ` for matter ${escapeHtml(opts.matterReference)}`
          : ""
      }.
    </p>
    <table style="border-collapse: collapse; margin: 0 0 16px;">${rows}
    </table>
    ${
      scheduled
        ? `<p style="margin: 0 0 16px;">The full payment schedule is set out in the attached invoice.</p>`
        : ""
    }
    ${
      opts.paymentUrl
        ? `<p style="margin: 0 0 24px;">
      <a href="${escapeHtml(opts.paymentUrl)}" style="display: inline-block; padding: 10px 20px; background: #1a1a1a; color: #fff; border-radius: 6px; text-decoration: none;">Pay this invoice online</a>
    </p>`
        : ""
    }
    <p style="margin: 0 0 16px;">
      If you have any questions about this invoice, please reply to this email.
    </p>
    <p style="margin: 24px 0 0; color: #666; font-size: 13px;">${escapeHtml(opts.firmName)}</p>
  </div>
`;
};

/** Everything the PDF and the email need, in one round trip. */
const loadForDelivery = async (organizationId: string, invoiceId: string) => {
  const [row] = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      dueDate: invoices.dueDate,
      caseId: invoices.caseId,
      clientId: invoices.clientId,
      clientName: partyName,
      clientEmail: partyEmail,
      firmName: organization.name,
      firmEmail: organization.emailAddress,
      firmPhone: organization.phoneNumber,
      firmAddress: organization.address,
      firmCity: organization.city,
      firmState: organization.state,
      firmZip: organization.zipCode,
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
  return row;
};

/**
 * Build the PDF from the same detail payload the UI renders, so the archived
 * document, the emailed attachment and the on-screen invoice cannot disagree.
 * Trust lines are already withheld by `getById` for callers without IOLTA
 * access, so nothing extra is filtered here.
 */
export const buildInvoicePdf = async (
  organizationId: string,
  invoiceId: string,
  access: AccountAccess,
) => {
  const detail = await getById(organizationId, invoiceId, access);
  const meta = await loadForDelivery(organizationId, invoiceId);

  const firmAddress = [
    meta.firmAddress,
    [meta.firmCity, meta.firmState, meta.firmZip].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");

  const input: InvoicePdfInput = {
    invoiceNumber: detail.invoiceNumber,
    status: detail.status,
    issueDate: detail.issueDate,
    dueDate: detail.dueDate,
    notes: detail.notes,
    filingType: detail.filingType,
    // The party, not the client: an invoice raised during intake is billed to a
    // lead, and the PDF still has to say who it is addressed to.
    client: { name: detail.party.name, email: detail.party.email },
    matter: detail.matter ? { reference: detail.matter.reference } : null,
    attorney: detail.attorney,
    lineItems: detail.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      rate: l.rate,
      amount: l.amount,
      account: l.account,
    })),
    totals: detail.totals,
    instalments: detail.instalments,
    firm: {
      name: meta.firmName ?? "Your legal team",
      email: meta.firmEmail,
      phone: meta.firmPhone,
      address: firmAddress || null,
    },
  };

  return {
    buffer: await renderInvoicePdf(input),
    invoiceNumber: detail.invoiceNumber,
    // Returned so the email body can quote the real total and matter without a
    // second round trip.
    detail,
  };
};

const documentKeyFor = (
  organizationId: string,
  invoiceId: string,
  invoiceNumber: string,
) =>
  `invoices/${organizationId}/${invoiceId}/${invoiceNumber}-${Date.now()}.pdf`;

export type SendResult = {
  deliveryId: string;
  status: "sent" | "failed";
  recipientEmail: string;
  failureReason: string | null;
  attemptCount: number;
};

const deliver = async (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
  access: AccountAccess,
  opts: { isResend: boolean },
): Promise<SendResult> => {
  const meta = await loadForDelivery(organizationId, invoiceId);

  if (meta.status === "void") {
    throw new BadRequestError("A voided invoice cannot be sent");
  }
  // Same reasoning, different fact: the money already went back, so sending it
  // would ask the client to pay an invoice the firm has settled with them.
  if (meta.status === "refunded") {
    throw new BadRequestError("A refunded invoice cannot be sent");
  }
  if (!opts.isResend && meta.status !== "draft") {
    throw new BadRequestError(
      "This invoice has already been sent — use resend to deliver it again",
    );
  }
  if (!meta.clientEmail) {
    throw new BadRequestError(
      "This client has no email address on file, so the invoice cannot be sent",
    );
  }

  const [{ attempts }] = await db
    .select({ attempts: sql<number>`count(*)::int` })
    .from(invoiceDeliveries)
    .where(
      and(
        eq(invoiceDeliveries.organizationId, organizationId),
        eq(invoiceDeliveries.invoiceId, invoiceId),
      ),
    );

  // 1. Render and archive the exact bytes the client will receive.
  const { buffer, invoiceNumber, detail } = await buildInvoicePdf(
    organizationId,
    invoiceId,
    access,
  );
  const documentKey = documentKeyFor(organizationId, invoiceId, invoiceNumber);
  await storageService.upload({
    key: documentKey,
    body: buffer,
    contentType: "application/pdf",
  });

  // A link is only offered when it can actually take money. Sending one that
  // leads to "payment is not available" is worse than sending none.
  //
  // Per organization, not per deployment: this firm may still be in
  // underwriting while the firm next door is trading. Getting that wrong emails
  // a dead link to a client.
  const paymentUrl = (await paymentsEnabledFor(organizationId))
    ? paymentLinkFor(await mintPaymentLink(organizationId, invoiceId))
    : null;

  // 2. Commit the attempt BEFORE sending, so a crash leaves evidence.
  const [delivery] = await db
    .insert(invoiceDeliveries)
    .values({
      organizationId,
      invoiceId,
      channel: "email",
      recipientEmail: meta.clientEmail,
      documentKey,
      status: "pending",
      attemptCount: (attempts ?? 0) + 1,
      sentById: actorStaffId,
    })
    .returning();

  // 3. Send.
  try {
    await emailService.sendEmail({
      to: meta.clientEmail,
      subject: `Invoice ${invoiceNumber} from ${meta.firmName ?? "your legal team"}`,
      // Minted on every send, which retires the previous link. Only the hash
      // is stored, so there is no way to resend the old one — rotation is the
      // price of never holding the raw token.
      html: invoiceEmailTemplate({
        clientName: meta.clientName,
        firmName: meta.firmName ?? "Your legal team",
        invoiceNumber,
        total: detail.totals.balanceDue,
        dueDate: detail.dueDate,
        matterReference: detail.matter?.reference ?? null,
        instalmentCount: detail.instalments.length,
        // The first instalment still owing — on a resend after a payment, that
        // is the next one due, not the one already settled.
        firstInstalment:
          detail.instalments.find((i) => i.outstanding > 0) ?? null,
        paymentUrl,
      }),
      attachments: [
        {
          filename: `${invoiceNumber}.pdf`,
          content: buffer,
          contentType: "application/pdf",
        },
      ],
    });
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : "Unknown email failure";
    await db
      .update(invoiceDeliveries)
      .set({ status: "failed", failureReason })
      .where(eq(invoiceDeliveries.id, delivery!.id));

    log.failure("invoice.delivery_failed", failureReason, { invoiceNumber });

    // The invoice stays a draft. Reporting success here, or promoting it
    // anyway, is exactly the lie this whole flow exists to remove.
    return {
      deliveryId: delivery!.id,
      status: "failed",
      recipientEmail: meta.clientEmail,
      failureReason,
      attemptCount: delivery!.attemptCount,
    };
  }

  // 4. Only now is the invoice genuinely sent.
  const now = new Date();
  await db
    .update(invoiceDeliveries)
    .set({ status: "sent", deliveredAt: now, failureReason: null })
    .where(eq(invoiceDeliveries.id, delivery!.id));

  if (meta.status === "draft") {
    await db
      .update(invoices)
      .set({ status: "sent", sentAt: now, updatedAt: now })
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          eq(invoices.id, invoiceId),
        ),
      );
  }

  await logFinanceEvent({
    organizationId,
    action: "finance.invoice_sent",
    title: `${invoiceNumber} — sent to ${meta.clientEmail}`,
    description: opts.isResend ? "Resent" : null,
    invoiceId,
    caseId: meta.caseId,
    clientId: meta.clientId,
    actorId: actorStaffId,
  });

  if (meta.caseId && !opts.isResend) {
    await logCaseEvent({
      organizationId,
      caseId: meta.caseId,
      action: "case.invoice_created",
      summary: `Invoice ${invoiceNumber} sent to client`,
      actorId: actorStaffId,
    });
  }

  return {
    deliveryId: delivery!.id,
    status: "sent",
    recipientEmail: meta.clientEmail,
    failureReason: null,
    attemptCount: delivery!.attemptCount,
  };
};

const scheduleEmailTemplate = (opts: {
  clientName: string;
  firmName: string;
  invoiceNumber: string;
  revised: boolean;
  total: number;
  instalments: {
    sequence: number;
    dueDate: string;
    amount: number;
    outstanding: number;
  }[];
}): string => {
  const rows = opts.instalments
    .map(
      (i) => `
      <tr>
        <td style="padding: 6px 16px 6px 0; color: #666;">${i.sequence}.</td>
        <td style="padding: 6px 16px 6px 0;">${escapeHtml(i.dueDate)}</td>
        <td style="padding: 6px 0; text-align: right;"><b>${money(i.amount)}</b></td>
        <td style="padding: 6px 0 6px 16px; color: #666;">${
          i.outstanding <= 0 ? "Paid" : ""
        }</td>
      </tr>`,
    )
    .join("");

  return `
  <div style="font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #1a1a1a;">
    <p style="margin: 0 0 16px;">Dear ${escapeHtml(opts.clientName)},</p>
    <p style="margin: 0 0 16px;">
      ${
        opts.revised
          ? `The payment schedule for invoice <b>${escapeHtml(opts.invoiceNumber)}</b> has been updated. The dates and amounts below replace the ones you were sent previously.`
          : `A payment schedule has been set up for invoice <b>${escapeHtml(opts.invoiceNumber)}</b>. You can pay it in the instalments below rather than in one payment.`
      }
    </p>
    <table style="border-collapse: collapse; margin: 0 0 16px;">${rows}
    </table>
    <p style="margin: 0 0 16px; color: #666;">
      Total ${money(opts.total)}. An updated copy of the invoice is attached.
    </p>
    <p style="margin: 0 0 16px;">
      If any of these dates do not work for you, please reply to this email.
    </p>
    <p style="margin: 24px 0 0; color: #666; font-size: 13px;">${escapeHtml(opts.firmName)}</p>
  </div>
`;
};

/**
 * Tell the client their payment plan was set up or changed.
 *
 * Follows the same ordering as `deliver`, and for the same reason: archive the
 * document, COMMIT a pending row, send, then record the outcome. An email
 * cannot be rolled back, so the evidence has to exist before it goes out.
 *
 * Silent no-op on an invoice the client has never received — there is no plan
 * to tell them about yet, and the schedule ships with the invoice when it is
 * sent. Also a no-op when they have no email address: refusing the schedule
 * change over an undeliverable notification would be the wrong trade, so the
 * caller gets `null` and can say so.
 */
export const sendScheduleUpdate = async (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
  access: AccountAccess,
  opts: { revised: boolean },
): Promise<SendResult | null> => {
  const meta = await loadForDelivery(organizationId, invoiceId);

  if (
    meta.status === "draft" ||
    meta.status === "void" ||
    meta.status === "refunded"
  ) {
    return null;
  }
  if (!meta.clientEmail) return null;

  const [{ attempts }] = await db
    .select({ attempts: sql<number>`count(*)::int` })
    .from(invoiceDeliveries)
    .where(
      and(
        eq(invoiceDeliveries.organizationId, organizationId),
        eq(invoiceDeliveries.invoiceId, invoiceId),
      ),
    );

  const { buffer, invoiceNumber, detail } = await buildInvoicePdf(
    organizationId,
    invoiceId,
    access,
  );

  // Nothing to announce. Removing a schedule lands here; the client is told by
  // the ordinary invoice, not by a table with no rows in it.
  if (detail.instalments.length === 0) return null;

  const documentKey = documentKeyFor(organizationId, invoiceId, invoiceNumber);
  await storageService.upload({
    key: documentKey,
    body: buffer,
    contentType: "application/pdf",
  });

  const [delivery] = await db
    .insert(invoiceDeliveries)
    .values({
      organizationId,
      invoiceId,
      channel: "email",
      kind: "schedule_update",
      recipientEmail: meta.clientEmail,
      documentKey,
      status: "pending",
      attemptCount: (attempts ?? 0) + 1,
      sentById: actorStaffId,
    })
    .returning();

  try {
    await emailService.sendEmail({
      to: meta.clientEmail,
      subject: `${opts.revised ? "Updated payment schedule" : "Payment schedule"} — invoice ${invoiceNumber}`,
      html: scheduleEmailTemplate({
        clientName: meta.clientName,
        firmName: meta.firmName ?? "Your legal team",
        invoiceNumber,
        revised: opts.revised,
        total: detail.totals.total,
        instalments: detail.instalments,
      }),
      attachments: [
        {
          filename: `${invoiceNumber}.pdf`,
          content: buffer,
          contentType: "application/pdf",
        },
      ],
    });
  } catch (error) {
    const failureReason =
      error instanceof Error ? error.message : "Unknown email failure";
    await db
      .update(invoiceDeliveries)
      .set({ status: "failed", failureReason })
      .where(eq(invoiceDeliveries.id, delivery!.id));

    log.failure("invoice.schedule_delivery_failed", failureReason, { invoiceNumber });

    // The schedule itself is already committed. Reporting the failure lets the
    // caller say "saved, but not delivered" rather than implying the client
    // knows about dates they have never seen.
    return {
      deliveryId: delivery!.id,
      status: "failed",
      recipientEmail: meta.clientEmail,
      failureReason,
      attemptCount: delivery!.attemptCount,
    };
  }

  await db
    .update(invoiceDeliveries)
    .set({ status: "sent", deliveredAt: new Date(), failureReason: null })
    .where(eq(invoiceDeliveries.id, delivery!.id));

  await logFinanceEvent({
    organizationId,
    action: opts.revised
      ? "finance.invoice_schedule_revised"
      : "finance.invoice_schedule_set",
    title: `${invoiceNumber} — schedule sent to ${meta.clientEmail}`,
    invoiceId,
    caseId: meta.caseId,
    clientId: meta.clientId,
    actorId: actorStaffId,
  });

  return {
    deliveryId: delivery!.id,
    status: "sent",
    recipientEmail: meta.clientEmail,
    failureReason: null,
    attemptCount: delivery!.attemptCount,
  };
};

export const sendInvoice = (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
  access: AccountAccess,
) => deliver(organizationId, invoiceId, actorStaffId, access, { isResend: false });

export const resendInvoice = (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
  access: AccountAccess,
) => deliver(organizationId, invoiceId, actorStaffId, access, { isResend: true });

/** Attempt history for the invoice detail dialog. */
export const listDeliveries = async (
  organizationId: string,
  invoiceId: string,
) => {
  const rows = await db
    .select({
      id: invoiceDeliveries.id,
      channel: invoiceDeliveries.channel,
      kind: invoiceDeliveries.kind,
      recipientEmail: invoiceDeliveries.recipientEmail,
      status: invoiceDeliveries.status,
      failureReason: invoiceDeliveries.failureReason,
      attemptCount: invoiceDeliveries.attemptCount,
      createdAt: invoiceDeliveries.createdAt,
      deliveredAt: invoiceDeliveries.deliveredAt,
      sentByFirstName: staff.firstName,
      sentByLastName: staff.lastName,
    })
    .from(invoiceDeliveries)
    .leftJoin(staff, eq(staff.id, invoiceDeliveries.sentById))
    .where(
      and(
        eq(invoiceDeliveries.organizationId, organizationId),
        eq(invoiceDeliveries.invoiceId, invoiceId),
      ),
    )
    .orderBy(desc(invoiceDeliveries.createdAt));

  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    kind: r.kind,
    recipientEmail: r.recipientEmail,
    status: r.status,
    failureReason: r.failureReason,
    attemptCount: r.attemptCount,
    createdAt: r.createdAt,
    deliveredAt: r.deliveredAt,
    sentBy:
      `${r.sentByFirstName ?? ""} ${r.sentByLastName ?? ""}`.trim() || null,
  }));
};

/**
 * May this invoice be chased?
 *
 * The distinction that matters is absence of evidence versus evidence of
 * failure:
 *
 *   - any successful delivery                  → yes
 *   - no delivery rows at all, but `sentAt` set → yes. The invoice predates
 *     delivery tracking; it was issued by the old code path and may well have
 *     been sent by hand. Blocking these would break every invoice a firm
 *     already has.
 *   - delivery rows exist but none succeeded   → NO. Here we know the client
 *     never received it, which is exactly the case worth refusing.
 */
export const canChaseInvoice = async (
  organizationId: string,
  invoiceId: string,
): Promise<boolean> => {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      succeeded: sql<number>`count(*) FILTER (WHERE ${invoiceDeliveries.status} = 'sent')::int`,
    })
    .from(invoiceDeliveries)
    .where(
      and(
        eq(invoiceDeliveries.organizationId, organizationId),
        eq(invoiceDeliveries.invoiceId, invoiceId),
        // Only the invoice itself answers "has the client been billed". A
        // delivered schedule update proves they received something, not that
        // they ever got the bill it refers to.
        eq(invoiceDeliveries.kind, "invoice"),
      ),
    );

  if ((row?.succeeded ?? 0) > 0) return true;
  if ((row?.total ?? 0) > 0) return false;

  const [invoice] = await db
    .select({ sentAt: invoices.sentAt })
    .from(invoices)
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    )
    .limit(1);

  return invoice?.sentAt != null;
};
