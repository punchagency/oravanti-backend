import { html, raw, smsBody } from "../render";
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
    // `link` is optional: the questionnaire flow asks for outstanding documents
    // without minting a fresh access token, so it can only point the lead back
    // at the link they already hold.
    email: (ctx: { link?: string; documents?: string[] }, meta) => ({
      subject: "Outstanding documents for your intake",
      html: layout(
        `Hello ${meta.recipientName},`,
        html`<p>To continue with your intake, ${meta.firmName} still needs the following:</p>` +
          (ctx.documents?.length
            ? html`<ul>${raw(
                ctx.documents.map((doc) => html`<li>${doc}</li>`).join(""),
              )}</ul>`
            : "") +
          (ctx.link
            ? button(ctx.link, "Upload documents")
            : html`<p>Please upload them using your intake questionnaire link. If you have misplaced it, contact the office and we will send a new one.</p>`),
        meta,
      ),
    }),
    sms: (ctx: { link?: string }, meta) =>
      smsBody(
        meta.firmName,
        ctx.link
          ? `We still need some documents for your intake: ${ctx.link}`
          : "We still need some documents for your intake. Please use your questionnaire link.",
      ),
  },

  consultation_booking_link: {
    email: (
      ctx: {
        link: string;
        requiresPayment?: boolean;
        amount?: string;
        /**
         * An urgent consultation is scheduled for the earliest slot rather than
         * chosen by the lead, so the copy must not tell them to pick a time
         * they will never be offered.
         */
        urgent?: boolean;
      },
      meta,
    ) => ({
      subject: ctx.requiresPayment
        ? "Action needed: pay your consultation fee"
        : "Pick a time for your consultation",
      html: layout(
        `Hello ${meta.recipientName},`,
        (ctx.requiresPayment
          ? html`<p>Please pay your consultation fee${
              ctx.amount ? html` of <strong>${ctx.amount}</strong>` : ""
            }${
              ctx.urgent
                ? " to be connected with an attorney as soon as possible"
                : " and then choose a time that works for you"
            }.</p>`
          : ctx.urgent
            ? html`<p>${meta.firmName} will connect you with an attorney as soon as possible.</p>`
            : html`<p>Please choose a time that works for your consultation.</p>`) +
          button(
            ctx.link,
            ctx.requiresPayment
              ? "Pay now"
              : ctx.urgent
                ? "View your consultation"
                : "Choose a time",
          ) +
          (ctx.urgent && ctx.requiresPayment
            ? html`<p>You'll receive your confirmation with the scheduled time immediately after payment.</p>`
            : ""),
        meta,
      ),
    }),
    sms: (ctx: { link: string; requiresPayment?: boolean }, meta) =>
      smsBody(
        meta.firmName,
        ctx.requiresPayment
          ? `Please pay your consultation fee to book: ${ctx.link}`
          : `Book your consultation here: ${ctx.link}`,
      ),
  },
} satisfies Partial<Record<string, TemplateDef>>;
