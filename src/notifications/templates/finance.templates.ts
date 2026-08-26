import { html, smsBody } from "../render";
import type { TemplateDef, TemplateMeta } from "./index";

const layout = (heading: string, body: string, meta: TemplateMeta) => html`
  <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #1a1a1a; line-height: 1.6;">
    <h2 style="font-size: 18px; margin: 0 0 16px;">${heading}</h2>
    ${{ __raw: body }}
    <p style="color: #666; font-size: 13px; margin-top: 28px;">Sent by ${meta.firmName}</p>
  </div>
`;

/**
 * Money amounts arrive as pre-formatted strings, never as numbers.
 *
 * The repo models money as numeric(15,4) and formats it at the boundary that
 * knows the currency. Passing a raw number into a template would invite
 * `toFixed(2)` here and a second, divergent notion of what an amount looks
 * like — with the added hazard that this context is persisted as jsonb and
 * re-rendered later.
 */
type MoneyContext = { amount: string; invoiceNumber?: string };

export const financeTemplates = {
  payment_followup: {
    email: (
      ctx: MoneyContext & { link?: string; message?: string; dueDate?: string },
      meta,
    ) => ({
      subject: ctx.invoiceNumber
        ? `Payment reminder — invoice ${ctx.invoiceNumber}`
        : "Payment reminder",
      html: layout(
        `Hello ${meta.recipientName},`,
        (ctx.message
          ? html`<p>${ctx.message}</p>`
          : html`<p>This is a reminder that ${ctx.amount} remains outstanding${
              ctx.invoiceNumber ? html` on invoice ${ctx.invoiceNumber}` : ""
            }.</p>`) +
          (ctx.dueDate ? html`<p><strong>Due:</strong> ${ctx.dueDate}</p>` : "") +
          (ctx.link
            ? html`<p style="margin:24px 0;"><a href="${ctx.link}" style="display:inline-block;padding:11px 22px;background:#1a56db;color:#fff;text-decoration:none;border-radius:6px;">Pay now</a></p>`
            : ""),
        meta,
      ),
    }),
    sms: (ctx: MoneyContext & { link?: string }, meta) =>
      smsBody(
        meta.firmName,
        ctx.link
          ? `${ctx.amount} is outstanding. Pay here: ${ctx.link}`
          : `${ctx.amount} is outstanding on your account.`,
      ),
  },

  payment_receipt_sent: {
    email: (ctx: MoneyContext & { paidAt?: string; balance?: string }, meta) => ({
      subject: ctx.invoiceNumber
        ? `Payment received — invoice ${ctx.invoiceNumber}`
        : "Payment received",
      html: layout(
        `Hello ${meta.recipientName},`,
        html`<p>Thank you. ${meta.firmName} has received your payment of <strong>${ctx.amount}</strong>${
          ctx.invoiceNumber ? html` for invoice ${ctx.invoiceNumber}` : ""
        }.</p>` +
          (ctx.paidAt ? html`<p><strong>Received:</strong> ${ctx.paidAt}</p>` : "") +
          (ctx.balance
            ? html`<p><strong>Remaining balance:</strong> ${ctx.balance}</p>`
            : ""),
        meta,
      ),
    }),
  },

  payment_received_staff: {
    email: (
      ctx: MoneyContext & { clientName?: string; link?: string },
      meta,
    ) => ({
      subject: `Payment received${ctx.invoiceNumber ? ` — ${ctx.invoiceNumber}` : ""}`,
      html: layout(
        "Payment received",
        html`<p><strong>${ctx.amount}</strong> received${
          ctx.clientName ? html` from ${ctx.clientName}` : ""
        }${ctx.invoiceNumber ? html` on invoice ${ctx.invoiceNumber}` : ""}.</p>` +
          (ctx.link ? html`<p><a href="${ctx.link}">View invoice</a></p>` : ""),
        meta,
      ),
    }),
    inApp: (ctx: MoneyContext & { clientName?: string; link?: string }) => ({
      title: "Payment received",
      body: `${ctx.amount} received${ctx.clientName ? ` from ${ctx.clientName}` : ""}`,
      href: ctx.link,
    }),
  },
} satisfies Partial<Record<string, TemplateDef>>;
