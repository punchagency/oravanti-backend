import nodemailer from "nodemailer";
import { env } from "../../config/env";
import {
  BaseEmailService,
  EMAIL_CONFIG,
  SendEmailOptions,
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

  async sendEmail(options: SendEmailOptions): Promise<void> {
    // `attachments` needs no mapping: nodemailer's attachment shape is exactly
    // { filename, content, contentType }, so the spread carries it through.
    const mailOptions = { ...options, from: EMAIL_CONFIG.fromAddress };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`[Gmail] Email sent to ${options.to}`);
    } catch (error) {
      console.error(`[Gmail] Failed to send email to ${options.to}:`, error);
      throw error;
    }
  }
}
