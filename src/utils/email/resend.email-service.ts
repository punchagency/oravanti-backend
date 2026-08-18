import { Resend } from "resend";
import { env } from "../../config/env";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import {
  BaseEmailService,
  EMAIL_CONFIG,
  SendEmailOptions,
} from "./email.types";

const log = createModuleLogger("resend.email-service");

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
        // Mapped explicitly rather than spread: Resend takes `content` as the
        // raw buffer and has no contentType field, inferring it from the
        // filename extension.
        ...(options.attachments?.length
          ? {
              attachments: options.attachments.map((file) => ({
                filename: file.filename,
                content: file.content,
              })),
            }
          : {}),
      });

      if (error) {
        log.failure(LogEvent.EMAIL_SEND_FAILED, error, { to: options.to });
        throw error;
      }
    } catch (error) {
      log.failure(LogEvent.EMAIL_SEND_FAILED, error, { to: options.to });
      throw error;
    }
  }
}
