import { html, smsBody } from "../render";
import type { TemplateDef, TemplateMeta } from "./index";

/**
 * Intake-stage messages, all addressed to the lead.
 *
 * Every SMS body here is written to fit one GSM-7 segment (160 characters)
 * including the firm-name prefix, which is what the check asserts. That budget
 * is why they say less than the emails do: an SMS carries the link and the
 * reason, and the email carries the detail.
 */

const layout = (heading: string, body: string, meta: TemplateMeta) => html`
  <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #1a1a1a; line-height: 1.6;">
    <h2 style="font-size: 18px; margin: 0 0 16px;">${heading}</h2>
    ${{ __raw: body }}
    <p style="color: #666; font-size: 13px; margin-top: 28px;">
      Sent by ${meta.firmName}
    </p>
  </div>
`;

const button = (href: string, label: string) => html`
  <p style="margin: 24px 0;">
    <a href="${href}" style="display: inline-block; padding: 11px 22px; background: #1a56db; color: #fff; text-decoration: none; border-radius: 6px;">${label}</a>
  </p>
`;

export const intakeTemplates = {
  questionnaire_sent: {
    email: (ctx: { link: string }, meta) => ({
      subject: `Your intake questionnaire from ${meta.firmName}`,
      html: layout(
        `Hello ${meta.recipientName},`,
        html`<p>${meta.firmName} has sent you an intake questionnaire. Completing it helps them prepare for your matter before you speak.</p>` +
          button(ctx.link, "Complete questionnaire") +
          html`<p style="color:#666;font-size:13px;">If the button does not work, copy this link into your browser:<br />${ctx.link}</p>`,
        meta,
      ),
    }),
    sms: (ctx: { link: string }, meta) =>
      smsBody(meta.firmName, `Please complete your intake questionnaire: ${ctx.link}`),
  },

  questionnaire_reminder: {
    email: (ctx: { link?: string }, meta) => ({
      subject: "Reminder: please complete your intake questionnaire",
      html: layout(
        `Hello ${meta.recipientName},`,
        html`<p>This is a friendly reminder to complete your intake questionnaire for ${meta.firmName}.</p>` +
          (ctx.link
            ? button(ctx.link, "Complete questionnaire")
            : html`<p>If you have misplaced your link, please contact the office and we will send a new one.</p>`),
        meta,
      ),
    }),
    sms: (ctx: { link?: string }, meta) =>
      smsBody(
        meta.firmName,
        ctx.link
          ? `Reminder: your intake questionnaire is still outstanding. ${ctx.link}`
          : "Reminder: your intake questionnaire is still outstanding. Contact us for a new link.",
      ),
  },

  missing_documents_requested: {
    email: (ctx: { link: string; documents?: string[] }, meta) => ({
      subject: `${meta.firmName} needs a few more documents`,
      html: layout(
        `Hello ${meta.recipientName},`,
        html`<p>To continue with your matter, ${meta.firmName} needs the following:</p>` +
          (ctx.documents?.length
            ? html`<ul>${{
                __raw: ctx.documents
                  .map((doc) => html`<li>${doc}</li>`)
                  .join(""),
              }}</ul>`
            : "") +
          button(ctx.link, "Upload documents"),
        meta,
      ),
    }),
    sms: (ctx: { link: string }, meta) =>
      smsBody(meta.firmName, `We need a few more documents for your matter: ${ctx.link}`),
  },

  consultation_booking_link: {
    email: (ctx: { link: string; requiresPayment?: boolean; amount?: string }, meta) => ({
      subject: `Book your consultation with ${meta.firmName}`,
      html: layout(
        `Hello ${meta.recipientName},`,
        html`<p>${meta.firmName} is ready to schedule your consultation.</p>` +
          (ctx.requiresPayment && ctx.amount
            ? html`<p>A consultation fee of ${ctx.amount} is payable when you book.</p>`
            : "") +
          button(ctx.link, ctx.requiresPayment ? "Pay and book" : "Choose a time"),
        meta,
      ),
    }),
    sms: (ctx: { link: string }, meta) =>
      smsBody(meta.firmName, `Book your consultation here: ${ctx.link}`),
  },
} satisfies Partial<Record<string, TemplateDef>>;
