import { html, smsBody } from "../render";
import type { TemplateDef, TemplateMeta } from "./index";

/**
 * Consultation reminders.
 *
 * `when` is pre-formatted by the caller in the recipient's timezone rather than
 * being a Date rendered here. Reminders are scheduled hours or days ahead and
 * their context is persisted as jsonb, so a Date would have to be re-derived at
 * send time against whatever zone the worker happened to resolve — and a
 * reminder that names the wrong hour is worse than none.
 */

const layout = (heading: string, body: string, meta: TemplateMeta) => html`
  <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #1a1a1a; line-height: 1.6;">
    <h2 style="font-size: 18px; margin: 0 0 16px;">${heading}</h2>
    ${{ __raw: body }}
    <p style="color: #666; font-size: 13px; margin-top: 28px;">Sent by ${meta.firmName}</p>
  </div>
`;

type ReminderContext = {
  /** Already formatted in the recipient's zone, e.g. "Tue 14 Aug, 2:30 PM EDT". */
  when: string;
  /** "video" | "in_person" | "phone_call", rendered by the caller. */
  modeLabel?: string;
  joinUrl?: string;
  location?: string;
  attorneyName?: string;
};

type BalanceContext = {
  /** Formatted by the caller, in the recipient's zone. Empty when unknown. */
  when?: string;
  /** Pre-formatted currency, e.g. "$150.00" — the worker has no locale. */
  amount: string;
  payUrl?: string;
  invoiceNumber?: string;
};

const detail = (ctx: ReminderContext) =>
  (ctx.attorneyName ? html`<p><strong>With:</strong> ${ctx.attorneyName}</p>` : "") +
  (ctx.modeLabel ? html`<p><strong>Format:</strong> ${ctx.modeLabel}</p>` : "") +
  (ctx.location ? html`<p><strong>Location:</strong> ${ctx.location}</p>` : "") +
  (ctx.joinUrl
    ? html`<p><strong>Join:</strong> <a href="${ctx.joinUrl}">${ctx.joinUrl}</a></p>`
    : "");

export const consultationTemplates = {
  consultation_reminder_24h: {
    email: (ctx: ReminderContext, meta) => ({
      subject: `Reminder: your consultation with ${meta.firmName} is tomorrow`,
      html: layout(
        `Hello ${meta.recipientName},`,
        html`<p>This is a reminder that your consultation is scheduled for <strong>${ctx.when}</strong>.</p>` +
          detail(ctx) +
          html`<p>If you need to reschedule, please contact the office as soon as you can.</p>`,
        meta,
      ),
    }),
    sms: (ctx: ReminderContext, meta) =>
      smsBody(meta.firmName, `Reminder: your consultation is tomorrow, ${ctx.when}.`),
  },

  consultation_reminder_1h: {
    email: (ctx: ReminderContext, meta) => ({
      subject: `Your consultation with ${meta.firmName} starts soon`,
      html: layout(
        `Hello ${meta.recipientName},`,
        html`<p>Your consultation starts at <strong>${ctx.when}</strong>.</p>` + detail(ctx),
        meta,
      ),
    }),
    sms: (ctx: ReminderContext, meta) =>
      smsBody(
        meta.firmName,
        ctx.joinUrl
          ? `Your consultation starts at ${ctx.when}. Join: ${ctx.joinUrl}`
          : `Your consultation starts at ${ctx.when}.`,
      ),
  },

  /**
   * The balance of a deposit, once the consultation has happened.
   *
   * `payUrl` is minted at scheduling time and points at the invoice's existing
   * Confido link, whose amount tracks the next unpaid instalment — so by the
   * time this lands it is asking for the balance, not the deposit that was
   * already paid.
   */
  consultation_balance_due: {
    email: (ctx: BalanceContext, meta) => ({
      subject: `Balance due for your consultation with ${meta.firmName}`,
      html: layout(
        `Hello ${meta.recipientName},`,
        html`<p>Thank you for your consultation${ctx.when ? html` on <strong>${ctx.when}</strong>` : ""}.</p>` +
          html`<p>The remaining balance of <strong>${ctx.amount}</strong> is now due.</p>` +
          (ctx.payUrl
            ? html`<p><a href="${ctx.payUrl}">Pay the balance</a></p>`
            : html`<p>Please contact the office to settle it.</p>`) +
          (ctx.invoiceNumber
            ? html`<p style="color: #666; font-size: 13px;">Invoice ${ctx.invoiceNumber}</p>`
            : ""),
        meta,
      ),
    }),
  },
} satisfies Partial<Record<string, TemplateDef>>;
