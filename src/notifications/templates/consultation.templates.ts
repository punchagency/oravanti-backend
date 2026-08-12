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
} satisfies Partial<Record<string, TemplateDef>>;
