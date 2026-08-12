import twilio, { type Twilio } from "twilio";
import { validateRequest } from "twilio/lib/webhooks/webhooks";
import { env } from "../../config/env";
import { maskPhone } from "../../utils/phone";
import type {
  SendSmsInput,
  SendSmsResult,
  SmsInboundEvent,
  SmsProvider,
  SmsStatusEvent,
} from "./sms.provider";

/**
 * Twilio, as one platform-owned account shared by every firm.
 *
 * The same arrangement as Dropbox Sign: firms do not bring their own
 * credentials, and the firm identity travels in the message body (see
 * `smsBody`) rather than in the sender. That is a deliberate trade — a shared
 * number means shared deliverability reputation and a shared opt-out list,
 * which is exactly why consent.service.ts applies STOP across every
 * organization.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  private client: Twilio;

  constructor() {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      throw new Error(
        "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required when using TwilioSmsProvider",
      );
    }
    this.client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    try {
      const message = await this.client.messages.create({
        to: input.to,
        body: input.body,
        // A Messaging Service is preferred over a bare number: it provides
        // sender pools, sticky sender, and carrier-level Advanced Opt-Out.
        // The single number is the local and trial fallback.
        ...(env.TWILIO_MESSAGING_SERVICE_SID
          ? { messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID }
          : { from: env.TWILIO_FROM_NUMBER }),
        ...(input.statusCallbackUrl
          ? { statusCallback: input.statusCallbackUrl }
          : {}),
      });

      return { providerMessageId: message.sid, status: message.status };
    } catch (error) {
      console.error(`[twilio] send failed to ${maskPhone(input.to)}:`, error);
      throw error;
    }
  }

  /**
   * Twilio signs an HMAC-SHA1 over the request URL concatenated with its form
   * parameters sorted by key — NOT over the raw body, unlike Stripe and Resend.
   *
   * `url` must be the exact URL Twilio was configured with. Reconstructing it
   * from req.protocol fails behind a proxy, where the app sees "http" while
   * Twilio signed "https", and rejects every legitimate request as forged —
   * which looks like an attack rather than a configuration bug. Hence
   * TWILIO_WEBHOOK_BASE_URL.
   */
  verifyWebhook(
    url: string,
    params: Record<string, string>,
    signature: string,
  ): boolean {
    if (!env.TWILIO_AUTH_TOKEN || !signature) return false;

    return validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
  }

  parseStatusCallback(params: Record<string, string>): SmsStatusEvent | null {
    const providerMessageId = params.MessageSid ?? params.SmsSid;
    const status = params.MessageStatus ?? params.SmsStatus;

    if (!providerMessageId || !status) return null;

    return {
      providerMessageId,
      status,
      ...(params.ErrorCode ? { errorCode: params.ErrorCode } : {}),
      ...(params.ErrorMessage ? { errorMessage: params.ErrorMessage } : {}),
      ...(params.To ? { to: params.To } : {}),
    };
  }

  parseInbound(params: Record<string, string>): SmsInboundEvent | null {
    const providerMessageId = params.MessageSid ?? params.SmsSid;

    if (!providerMessageId || !params.From || !params.To) return null;

    return {
      from: params.From,
      to: params.To,
      body: params.Body ?? "",
      providerMessageId,
    };
  }
}
