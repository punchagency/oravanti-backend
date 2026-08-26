import { randomUUID } from "crypto";
import { env } from "../../config/env";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import { maskPhone } from "../../utils/phone";

const log = createModuleLogger("notifications.sms_provider");

/**
 * Contract for sending a text message, across more than one vendor.
 *
 * Modelled on `src/modules/finance/payment.provider.ts` — interface, stub,
 * cached factory, `isXConfigured()` — so the two read alike.
 *
 * The seam exists separately from any implementation because "no provider
 * configured" is a state this system will spend real time in, not a
 * transitional gap. US long-code SMS requires A2P 10DLC brand and campaign
 * registration, which is an external, human-reviewed process measured in weeks;
 * unregistered traffic is filtered by carriers rather than delivered. The whole
 * notification layer therefore has to work, and be testable, against a provider
 * that sends nothing.
 *
 * ── Why the webhook shape is raw bytes ──────────────────────────────────────
 * Vendors do not agree on what they sign. Twilio signs the request URL
 * concatenated with its form parameters sorted by key; Telnyx signs
 * `timestamp|rawBody` with Ed25519. Raw bytes are the only shape that serves
 * both: a form-encoded provider can parse them, but a byte-signing provider
 * cannot reconstruct them once Express has parsed and discarded them. Same
 * reasoning already written into app.ts for Stripe and Resend.
 */

export const SMS_PROVIDER_NAMES = ["twilio", "telnyx"] as const;
export type SmsProviderName = (typeof SMS_PROVIDER_NAMES)[number];

/**
 * The normalised delivery vocabulary. A subset of notificationStatusEnum,
 * deliberately: each provider maps its own words onto these, so no shared table
 * has to know two vendors' vocabularies at once.
 */
export type SmsDeliveryStatus = "queued" | "sent" | "delivered" | "failed";

export interface SendSmsInput {
  /** E.164. Callers normalise before reaching here; the provider does not guess. */
  to: string;
  body: string;
}

export interface SendSmsResult {
  /** The provider's id for this message — how a later status callback finds the row. */
  providerMessageId: string;
  /** Normalised, for our own status column. */
  status: SmsDeliveryStatus;
  /** The provider's own word, kept raw for support conversations. */
  providerStatus: string;
}

/**
 * A webhook exactly as it arrived.
 *
 * `url` is the URL the provider was CONFIGURED to call, read from env — never
 * rebuilt from the request. Twilio signs it, and behind a proxy `req.protocol`
 * reports "http" where Twilio signed "https", which rejects every legitimate
 * request as forged. Providers that do not sign the URL simply ignore it.
 */
export interface SmsWebhookRequest {
  rawBody: Buffer;
  /** Lowercased header names. */
  headers: Record<string, string>;
  url: string;
}

export interface SmsStatusEvent {
  providerMessageId: string;
  /** Already normalised BY THE PROVIDER. */
  status: SmsDeliveryStatus;
  /** Raw provider word, for the provider_status column. */
  providerStatus: string;
  /**
   * True when the provider did not recognise its own vendor's word. The handler
   * leaves our status alone and logs it, so a vendor adding a status is visible
   * rather than silently parking a row.
   */
  unmapped: boolean;
  errorCode?: string;
  errorMessage?: string;
  /** Recipient, resolved BY THE PROVIDER — no caller reaches past this. */
  to?: string;
  /**
   * The provider decided this is a "recipient has opted out" terminal error.
   *
   * `source` is written to smsConsentSource, so it stays vendor-specific on
   * purpose: "twilio_21610" is already in the database on historical rows, and
   * generalising it would strand them in a vocabulary nothing else uses.
   */
  optOut?: { source: string };
}

export interface SmsInboundEvent {
  from: string;
  to: string;
  body: string;
  providerMessageId: string;
}

export type SmsWebhookEvent =
  | ({ kind: "status" } & SmsStatusEvent)
  | ({ kind: "inbound" } & SmsInboundEvent);

/** What the route writes back. Built by the provider, written by the route. */
export interface SmsWebhookResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface SmsProvider {
  readonly name: SmsProviderName | "stub";

  /**
   * Whether this provider will report delivery back to us — false when no
   * callback base URL is configured. The SMS twin of
   * isEmailDeliveryTrackingConfigured(), so the worker can mark a row
   * `no_delivery_tracking` rather than leaving it apparently stuck at `sent`.
   */
  readonly deliveryTrackingEnabled: boolean;

  sendSms(input: SendSmsInput): Promise<SendSmsResult>;

  /**
   * True when this request is authentic.
   *
   * A predicate rather than a throw, because the check asserts it directly and
   * a predicate is assertable without a try/catch per case. The reason is not
   * lost: implementations log sms.webhook_signature_invalid at warn before
   * returning false. The handler is what throws.
   */
  verifyWebhook(req: SmsWebhookRequest): boolean;

  /**
   * One parse for both callback kinds, returning a discriminated union.
   *
   * Not two methods: Telnyx uses ONE webhook URL per messaging profile carrying
   * message.sent / message.finalized / message.received. Two methods would make
   * the route guess from the path, and a profile pointed at one path would
   * silently drop half its events. Dispatching on `kind` makes the path
   * irrelevant.
   */
  parseWebhook(req: SmsWebhookRequest): SmsWebhookEvent | null;

  /**
   * How a reply to an inbound message reaches the sender.
   *
   * Twilio embeds it in TwiML and returns it in the response; Telnyx must send
   * it through the API and return a bare 200. Owning it here is what keeps the
   * shared handler from branching on provider.name.
   */
  respondToInbound(
    reply: string | null,
    to: string | null,
  ): Promise<SmsWebhookResponse>;
}

/**
 * The fallback when no provider is configured.
 *
 * It logs and returns a synthetic id. Unlike the payment stub, a plausible
 * result is safe here: an SMS that did not send costs nobody money and writes
 * to no ledger, and the notification row is marked
 * `skipped/provider_unconfigured` before it ever reaches a provider.
 */
export class StubSmsProvider implements SmsProvider {
  readonly name = "stub";
  readonly deliveryTrackingEnabled = false;

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    // Masked: a full phone number in a log is a phone number in every log
    // aggregator downstream.
    log.info(LogEvent.SMS_STUB_SEND, { toMasked: maskPhone(input.to) });
    return {
      providerMessageId: `stub_${randomUUID()}`,
      status: "queued",
      providerStatus: "stub",
    };
  }

  /**
   * False, always.
   *
   * The stub cannot verify anything, and returning true would make two
   * unauthenticated public endpoints accept any payload on the internet — one
   * of which opts phone numbers out of messaging across every firm, and the
   * other of which marks messages delivered. Following StubPaymentProvider
   * here, not StubESignatureProvider.
   */
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): SmsWebhookEvent | null {
    return null;
  }

  async respondToInbound(): Promise<SmsWebhookResponse> {
    return { status: 200, contentType: "text/plain", body: "" };
  }
}

const stubProvider = new StubSmsProvider();

let activeCache: SmsProvider | null = null;
const byName = new Map<SmsProviderName, SmsProvider>();

const construct = (name: SmsProviderName): SmsProvider => {
  if (name === "twilio") {
    // Required lazily so an unconfigured environment never loads the Twilio
    // SDK at all. A static import would pull it into every process that
    // touches notifications, configured or not.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TwilioSmsProvider } = require("./twilio.provider") as typeof import("./twilio.provider");
    return new TwilioSmsProvider();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TelnyxSmsProvider } = require("./telnyx.provider") as typeof import("./telnyx.provider");
  return new TelnyxSmsProvider();
};

const isKnownProvider = (value: string): value is SmsProviderName =>
  (SMS_PROVIDER_NAMES as readonly string[]).includes(value);

/**
 * The provider the SEND path uses, or the stub.
 *
 * An unset or unrecognised SMS_PROVIDER falls back to the stub rather than
 * throwing: this resolves lazily inside a request or a queue job, where a throw
 * takes down that request rather than the process, and the whole notification
 * layer is designed so "nothing configured" is a first-class state. But it is
 * never SILENT — an unrecognised value warns, once per process, because
 * SMS_PROVIDER=Twilio quietly sending nothing would be a nasty incident.
 */
export const getSmsProvider = (): SmsProvider => {
  if (activeCache) return activeCache;

  // Lowercased here as well as in validateEnv: this is the last line of
  // defence, and SMS_PROVIDER=Twilio quietly sending nothing would be a
  // nasty incident to diagnose.
  const configured = env.SMS_PROVIDER?.trim().toLowerCase();

  if (!configured) {
    log.debug(LogEvent.SMS_PROVIDER_UNSET);
    activeCache = stubProvider;
  } else if (!isKnownProvider(configured)) {
    log.warn(LogEvent.SMS_PROVIDER_UNRECOGNISED, {
      value: configured,
      expected: [...SMS_PROVIDER_NAMES],
    });
    activeCache = stubProvider;
  } else if (!isSmsProviderConfigured(configured)) {
    log.warn(LogEvent.SMS_PROVIDER_UNCONFIGURED, { provider: configured });
    activeCache = stubProvider;
  } else {
    activeCache = construct(configured);
    log.info(LogEvent.SMS_PROVIDER_SELECTED, { provider: configured });
  }

  return activeCache;
};

/**
 * The provider that verifies a webhook on a given route — NOT env-dependent.
 *
 * This is the reason webhook routes bind by name. If a route resolved the
 * ACTIVE provider instead, flipping SMS_PROVIDER to telnyx would hand a Twilio
 * callback to the Telnyx verifier, fail, and throw. Twilio would retry forever
 * and the opted-out error code — often the only signal that a recipient said
 * STOP — would be lost with it.
 *
 * Returns null when that provider's credentials are absent, which leaves its
 * endpoint inert rather than forgeable.
 */
export const getSmsProviderByName = (
  name: SmsProviderName,
): SmsProvider | null => {
  const existing = byName.get(name);
  if (existing) return existing;

  if (!isSmsProviderConfigured(name)) return null;

  const provider = construct(name);
  byName.set(name, provider);
  return provider;
};

/** Test seam: forces the next resolution to re-run. */
export const resetSmsProviderCache = () => {
  activeCache = null;
  byName.clear();
};

/**
 * True when a provider is fully configured.
 *
 * With no argument this answers about the ACTIVE provider, and it must stay
 * that way. If it ever drifted to "any provider is configured", then
 * SMS_PROVIDER=telnyx with broken Telnyx credentials but working Twilio ones
 * would pass the channel gate in resolveChannelDecision, the stub would swallow
 * the send, and the row would read `sent` with no skip recorded.
 */
export const isSmsProviderConfigured = (name?: SmsProviderName): boolean => {
  const target =
    name ?? (env.SMS_PROVIDER?.trim().toLowerCase() as SmsProviderName | undefined);
  if (!target || !isKnownProvider(target)) return false;

  if (target === "twilio") {
    return Boolean(
      env.TWILIO_ACCOUNT_SID &&
        env.TWILIO_AUTH_TOKEN &&
        (env.TWILIO_MESSAGING_SERVICE_SID || env.TWILIO_FROM_NUMBER),
    );
  }

  /**
   * TELNYX_PUBLIC_KEY is demanded, not optional.
   *
   * It is the highest-consequence omission in this integration. Telnyx absorbs
   * STOP at the messaging-profile level, so its blocked-recipient error code is
   * often the ONLY opt-out signal we get. Without the key, sends work perfectly
   * while every opt-out signal is rejected as forged and the platform keeps
   * texting people who said stop, across every firm. Absent is therefore made
   * safe — the provider never resolves and nothing sends at all.
   */
  return Boolean(
    env.TELNYX_API_KEY &&
      env.TELNYX_PUBLIC_KEY &&
      (env.TELNYX_MESSAGING_PROFILE_ID || env.TELNYX_FROM_NUMBER),
  );
};

/**
 * True when Resend can report email delivery back to us.
 *
 * Lives here rather than beside the mailer because the communications UI asks
 * the same question of both channels at once: a row that stops at `sent`
 * forever is correct in development and a problem in production, and only this
 * tells them apart.
 */
export const isEmailDeliveryTrackingConfigured = (): boolean =>
  Boolean(env.RESEND_API_KEY && env.RESEND_WEBHOOK_SECRET);
