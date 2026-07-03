import { Resend } from "resend";
import { env } from "../../config/env";
import {
  BaseEmailService,
  EMAIL_CONFIG,
  SendEmailOptions,
} from "./email.types";

export class ResendEmailService extends BaseEmailService {
  private resend: Resend;

  constructor() {
    super();
    if (!env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required when using ResendEmailService");
    }
    this.resend = new Resend(env.RESEND_API_KEY);
  }

  async sendEmail(options: SendEmailOptions): Promise<void> {
    try {
      const { error } = await this.resend.emails.send({
        from: EMAIL_CONFIG.fromAddress,
        to: [options.to],
        subject: options.subject,
        html: options.html,
      });

      if (error) {
        console.error(`[Resend] Error sending email to ${options.to}:`, error);
        throw error;
      }
    } catch (error) {
      console.error(`[Resend] Failed to send email to ${options.to}:`, error);
      throw error;
    }
  }
}
