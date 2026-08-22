import twilio, { type Twilio } from "twilio";
import { validateRequest } from "twilio/lib/webhooks/webhooks";
import { env } from "../../config/env";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import { maskPhone } from "../../utils/phone";
import type {
  SendSmsInput,
  SendSmsResult,
  SmsDeliveryStatus,
  SmsProvider,
  SmsWebhookEvent,
  SmsWebhookRequest,
  SmsWebhookResponse,
} from "./sms.provider";

const log = createModuleLogger("notifications.twilio_provider");

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

/**
 * Twilio's terminal error for sending to a number that has opted out.
 *
 * Handled as a second, independent opt-out path: when Advanced Opt-Out absorbs
 * a STOP at the carrier level it may never forward the inbound message to us,
 * and this error is then the only signal our consent columns are stale.
 */
const OPTED_OUT_ERROR = "21610";

/** Twilio's message resource states, mapped onto our vocabulary. */
const STATUS_MAP: Record<string, SmsDeliveryStatus> = {
  queued: "queued",
  accepted: "queued",
  scheduled: "queued",
  sending: "queued",
  sent: "sent",
  delivered: "delivered",
  read: "delivered",
  undelivered: "failed",
  failed: "failed",
};

export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio" as const;
  private client: Twilio;

  constructor() {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
      throw new Error(
        "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required when using TwilioSmsProvider",
      );
    }
    this.client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }

  get deliveryTrackingEnabled(): boolean {
    return Boolean(env.TWILIO_WEBHOOK_BASE_URL);
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
        // The callback URL is built here rather than passed in, because its
        // shape is provider knowledge: Twilio calls it `statusCallback`,
        // Telnyx calls it `webhook_url`, and each owns its own route.
        ...(this.deliveryTrackingEnabled
          ? {
              statusCallback: `${env.TWILIO_WEBHOOK_BASE_URL}/webhooks/twilio/status`,
            }
          : {}),
      });

      return {
        providerMessageId: message.sid,
        status: STATUS_MAP[message.status] ?? "queued",
        providerStatus: message.status,
      };
    } catch (error) {
      log.failure(LogEvent.SMS_SEND_FAILED, error, {
        provider: "twilio",
        toMasked: maskPhone(input.to),
      });
      throw error;
    }
  }

  /**
   * Twilio signs an HMAC-SHA1 over the request URL concatenated with its form
   * parameters sorted by key — NOT the raw bytes, unlike Resend and Telnyx.
   *
   * The bytes still arrive raw (app.ts mounts express.raw for this path, so one
   * shape serves every provider), so they are parsed here before verification.
   */
  verifyWebhook(req: SmsWebhookRequest): boolean {
    const signature = req.headers["x-twilio-signature"];
    if (!env.TWILIO_AUTH_TOKEN || !signature) return false;

    const ok = validateRequest(
      env.TWILIO_AUTH_TOKEN,
      signature,
      req.url,
      this.formParams(req),
    );

    if (!ok) {
      log.warn(LogEvent.SMS_WEBHOOK_SIGNATURE_INVALID, { provider: "twilio" });
    }
    return ok;
  }

  parseWebhook(req: SmsWebhookRequest): SmsWebhookEvent | null {
    const params = this.formParams(req);
    const providerMessageId = params.MessageSid ?? params.SmsSid;
    if (!providerMessageId) return null;

    // An inbound message carries From/To/Body and no status. A status callback
    // carries MessageStatus. Distinguishing on the payload rather than the
    // route means a misconfigured console URL cannot drop half the events.
    const rawStatus = params.MessageStatus ?? params.SmsStatus;

    if (!rawStatus) {
      if (!params.From || !params.To) return null;
      return {
        kind: "inbound",
        from: params.From,
        to: params.To,
        body: params.Body ?? "",
        providerMessageId,
      };
    }

    const mapped = STATUS_MAP[rawStatus];
    const errorCode = params.ErrorCode;

    return {
      kind: "status",
      providerMessageId,
      // An unknown word is treated as progress, never as an outcome — the
      // handler leaves our status alone and logs it.
      status: mapped ?? "queued",
      providerStatus: rawStatus,
      unmapped: mapped === undefined,
      ...(errorCode ? { errorCode } : {}),
      ...(params.ErrorMessage ? { errorMessage: params.ErrorMessage } : {}),
      ...(params.To ? { to: params.To } : {}),
      ...(errorCode === OPTED_OUT_ERROR
        ? { optOut: { source: "twilio_21610" } }
        : {}),
    };
  }

  /**
   * TwiML. An empty <Response/> means "received, say nothing back", which is
   * the right answer to a STOP: Advanced Opt-Out sends the compliant
   * confirmation, and a second message to someone who just asked us to stop is
   * what they asked us not to do.
   */
  async respondToInbound(reply: string | null): Promise<SmsWebhookResponse> {
    return {
      status: 200,
      contentType: "text/xml",
      body: reply
        ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`
        : `<?xml version="1.0" encoding="UTF-8"?><Response/>`,
    };
  }

  private formParams(req: SmsWebhookRequest): Record<string, string> {
    const parsed = new URLSearchParams(req.rawBody.toString("utf8"));
    return Object.fromEntries(parsed.entries());
  }
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
