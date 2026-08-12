import nodemailer from "nodemailer";
import { env } from "../../config/env";
import {
  BaseEmailService,
  EMAIL_CONFIG,
  SendEmailOptions,
  SendEmailResult,
} from "./email.types";

export class GmailEmailService extends BaseEmailService {
  private transporter;

  constructor() {
    super();
    this.transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: env.SMTP_EMAIL_ADDRESS,
        pass: env.SMTP_PASSWORD,
      },
    });
  }

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    // `attachments` needs no mapping: nodemailer's attachment shape is exactly
    // { filename, content, contentType }, so the spread carries it through.
    const mailOptions = { ...options, from: EMAIL_CONFIG.fromAddress };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log(`[Gmail] Email sent to ${options.to}`);

      // A real SMTP Message-ID, but nothing will ever reference it: Gmail SMTP
      // emits no delivery callbacks, so email notifications sent in
      // development correctly stop at `sent` and never reach `delivered`.
      return { providerMessageId: info.messageId ?? null };
    } catch (error) {
      console.error(`[Gmail] Failed to send email to ${options.to}:`, error);
      throw error;
    }
  }
}
