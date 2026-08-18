import nodemailer from "nodemailer";
import { env } from "../../config/env";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import {
  BaseEmailService,
  EMAIL_CONFIG,
  SendEmailOptions,
} from "./email.types";

const log = createModuleLogger("gmail.email-service");

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
      log.info(LogEvent.EMAIL_SENT, { to: options.to });
    } catch (error) {
      log.failure(LogEvent.EMAIL_SEND_FAILED, error, { to: options.to });
      throw error;
    }
  }
}
