import { randomUUID } from "crypto";
import { env } from "../../config/env";
import { maskPhone } from "../../utils/phone";

/**
 * Contract for sending a text message.
 *
 * Modelled on `src/modules/finance/payment.provider.ts` — interface, stub,
 * cached factory, `isXConfigured()` — so the two read alike.
 *
 * The seam exists separately from the Twilio implementation because "no
 * provider configured" is a state this system will spend real time in, not a
 * transitional gap. US long-code SMS requires A2P 10DLC brand and campaign
 * registration, which is an external, human-reviewed process measured in weeks;
 * unregistered traffic is filtered by carriers rather than delivered. The whole
 * notification layer therefore has to work, and be testable, against a provider
 * that sends nothing.
 */

export interface SendSmsInput {
  /** E.164. Callers normalise before reaching here; the provider does not guess. */
  to: string;
  body: string;
  /** Where the provider should report delivery. Omitted when tracking is not configured. */
  statusCallbackUrl?: string;
}

export interface SendSmsResult {
  /** The provider's id for this message — how a later status callback finds the row. */
  providerMessageId: string;
  /** The provider's own word for what it did, stored raw for support. */
  status: string;
}

export interface SmsStatusEvent {
  providerMessageId: string;
  /** Provider vocabulary: queued | sent | delivered | undelivered | failed. */
  status: string;
  errorCode?: string;
  errorMessage?: string;
  /** The recipient, so an opt-out signalled by error code can be applied. */
  to?: string;
}

export interface SmsInboundEvent {
  from: string;
  to: string;
  body: string;
  providerMessageId: string;
}

export interface SmsProvider {
  readonly name: string;

  sendSms(input: SendSmsInput): Promise<SendSmsResult>;

  /**
   * Verify a webhook came from the provider.
   *
   * Takes the URL and the parsed form parameters rather than a raw body,
   * because that is what Twilio actually signs: an HMAC over the request URL
   * concatenated with its sorted parameters. This differs from Stripe and
   * Resend, which sign the raw bytes — hence the two different body parsers in
   * app.ts.
   */
  verifyWebhook(
    url: string,
    params: Record<string, string>,
    signature: string,
  ): boolean;

  /** Extract a delivery status update, or null for callbacks we do not act on. */
  parseStatusCallback(params: Record<string, string>): SmsStatusEvent | null;

  /** Extract an inbound message, or null when the payload is not one. */
  parseInbound(params: Record<string, string>): SmsInboundEvent | null;
}

/**
 * The fallback when no provider is configured, which is every environment
 * today.
 *
 * It logs and returns a synthetic id. Unlike the payment stub, returning a
 * plausible result here is safe: an SMS that did not send costs nobody money
 * and writes nothing to a ledger, and the notification row it produces is
 * marked `skipped/provider_unconfigured` before it ever reaches a provider — so
 * the system never claims a delivery that did not happen.
 */
export class StubSmsProvider implements SmsProvider {
  readonly name = "stub";

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    // Masked: this line exists in development logs, and a full phone number in
    // a log is a phone number in every log aggregator downstream.
    console.log(`[sms-stub] -> ${maskPhone(input.to)}: ${input.body}`);
    return { providerMessageId: `stub_${randomUUID()}`, status: "queued" };
  }

  /**
   * False, always.
   *
   * The stub cannot verify anything, and returning true would make two
   * unauthenticated public endpoints accept any payload on the internet — one
   * of which opts phone numbers out of messaging across every firm, and the
   * other of which marks messages delivered. Following StubPaymentProvider
   * here, not StubESignatureProvider: the e-signature stub can afford to return
   * true because it sits behind a signature request only the firm can create.
   */
  verifyWebhook(): boolean {
    return false;
  }

  parseStatusCallback(): SmsStatusEvent | null {
    return null;
  }

  parseInbound(): SmsInboundEvent | null {
    return null;
  }
}

const stubProvider = new StubSmsProvider();

let cached: SmsProvider | null = null;

/**
 * The configured provider, or the stub. Import from here rather than
 * constructing directly, so the fallback is consistent across the codebase.
 */
export const getSmsProvider = (): SmsProvider => {
  if (cached) return cached;
  // The Twilio implementation slots in here, exactly as DropboxSignProvider
  // does in getESignatureProvider.
  cached = stubProvider;
  return cached;
};

/** Test seam: forces the next getSmsProvider() to re-resolve. */
export const resetSmsProviderCache = () => {
  cached = null;
};

/**
 * True when a real provider is configured.
 *
 * Demands the account SID, the auth token AND a sender. The auth token is what
 * verifies the status and inbound webhooks, so a configured sender without it
 * would leave those endpoints unable to check what they are sent while the rest
 * of the system believed SMS was live — the same reasoning as
 * isPaymentProviderConfigured() demanding the webhook secret.
 */
export const isSmsProviderConfigured = (): boolean =>
  Boolean(
    env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER),
  );

/**
 * True when Resend can report email delivery back to us.
 *
 * Lives here rather than beside the mailer because it answers the same question
 * for the other channel, and the communications UI asks both together: an email
 * row that stops at `sent` forever is correct in development and a problem in
 * production, and only this tells them apart.
 */
export const isEmailDeliveryTrackingConfigured = (): boolean =>
  Boolean(env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET);
