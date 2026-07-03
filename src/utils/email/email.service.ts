import { env } from "../../config/env";
import { GmailEmailService } from "./gmail.email-service";
import { ResendEmailService } from "./resend.email-service";
import type { BaseEmailService } from "./email.types";

function createEmailService(): BaseEmailService {
  if (env.isProduction) {
    return new ResendEmailService();
  }
  return new GmailEmailService();
}

export const emailService = createEmailService();
