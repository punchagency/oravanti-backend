import { createPublicKey, verify as cryptoVerify } from "crypto";
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

const log = createModuleLogger("notifications.telnyx_provider");

/**
 * Telnyx, as one platform-owned account and Messaging Profile shared by every
 * firm — the same arrangement as Twilio, so the cross-tenant opt-out logic and
 * the firm-name-in-body behaviour carry over unchanged.
 *
 * No SDK. The send is one REST call, and Ed25519 verification is in node's
 * crypto, so a dependency would buy nothing but a supply-chain surface.
 */

const API_URL = "https://api.telnyx.com/v2/messages";

/**
 * Telnyx's terminal error for a recipient who has opted out — the analogue of
 * Twilio's 21610, and reached for the same reason: Telnyx absorbs STOP at the
 * messaging-profile level, so it may never forward the inbound message and this
 * error is then the only signal our consent columns are stale.
 */
const OPTED_OUT_ERROR = "40300";

/** Replay window for the signed timestamp. */
const MAX_SIGNATURE_AGE_SECONDS = 300;

/**
 * Telnyx's per-recipient delivery states, mapped onto our vocabulary.
 *
 * `delivery_unconfirmed` is the judgement call: Telnyx means "handed to the
 * carrier, never confirmed either way", which is common on some US carriers.
 * `failed` would have staff chasing clients who did receive the message;
 * `delivered` would claim something we cannot prove, in a ledger whose whole
 * point is not overstating itself. `sent` is the truthful answer, and
 * providerStatus keeps the raw word so the UI can say "delivery not confirmed".
 */
const STATUS_MAP: Record<string, SmsDeliveryStatus> = {
  queued: "queued",
  sending: "queued",
  sent: "sent",
  delivered: "delivered",
  delivery_unconfirmed: "sent",
  sending_failed: "failed",
  delivery_failed: "failed",
  expired: "failed",
};

type TelnyxEnvelope = {
  data?: {
    event_type?: string;
    payload?: {
      id?: string;
      text?: string;
      from?: { phone_number?: string };
      to?: { phone_number?: string; status?: string }[];
      errors?: { code?: string | number; title?: string; detail?: string }[];
    };
  };
};

export class TelnyxSmsProvider implements SmsProvider {
  readonly name = "telnyx" as const;

  constructor() {
    if (!env.TELNYX_API_KEY) {
      throw new Error("TELNYX_API_KEY is required when using TelnyxSmsProvider");
    }
  }

  get deliveryTrackingEnabled(): boolean {
    return Boolean(env.TELNYX_WEBHOOK_BASE_URL);
  }

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: input.to,
          text: input.body,
          // A Messaging Profile is preferred over a bare number for the same
          // reasons as Twilio's Messaging Service: number pools and
          // profile-level opt-out handling.
          ...(env.TELNYX_MESSAGING_PROFILE_ID
            ? { messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID }
            : { from: env.TELNYX_FROM_NUMBER }),
          ...(this.deliveryTrackingEnabled
            ? {
                webhook_url: `${env.TELNYX_WEBHOOK_BASE_URL}/webhooks/telnyx`,
              }
            : {}),
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Telnyx responded ${response.status}: ${detail.slice(0, 300)}`,
        );
      }

      const body = (await response.json()) as TelnyxEnvelope;
      const payload = body.data?.payload ?? (body.data as TelnyxEnvelope["data"] & { id?: string });
      const providerMessageId = (payload as { id?: string })?.id;

      if (!providerMessageId) {
        throw new Error("Telnyx accepted the message but returned no id");
      }

      // The send response carries per-recipient status too; read it the same
      // way the webhook does so one mapping serves both.
      const rawStatus =
        (payload as { to?: { status?: string }[] })?.to?.[0]?.status ?? "queued";

      return {
        providerMessageId,
        status: STATUS_MAP[rawStatus] ?? "queued",
        providerStatus: rawStatus,
      };
    } catch (error) {
      log.failure(LogEvent.SMS_SEND_FAILED, error, {
        provider: "telnyx",
        toMasked: maskPhone(input.to),
      });
      throw error;
    }
  }

  /**
   * Telnyx signs `${timestamp}|${rawBody}` with Ed25519 — the raw bytes, not
   * the URL, and verified against a PUBLIC key rather than the sending
   * credential. That asymmetry is why TELNYX_PUBLIC_KEY is demanded separately
   * by isSmsProviderConfigured.
   */
  verifyWebhook(req: SmsWebhookRequest): boolean {
    const signature = req.headers["telnyx-signature-ed25519"];
    const timestamp = req.headers["telnyx-timestamp"];

    if (!env.TELNYX_PUBLIC_KEY || !signature || !timestamp) {
      log.warn(LogEvent.SMS_WEBHOOK_SIGNATURE_INVALID, {
        provider: "telnyx",
        reason: "missing_key_or_headers",
      });
      return false;
    }

    // The timestamp is what defeats replay of a captured payload; the signature
    // alone would stay valid forever.
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > MAX_SIGNATURE_AGE_SECONDS) {
      log.warn(LogEvent.SMS_WEBHOOK_SIGNATURE_INVALID, {
        provider: "telnyx",
        reason: "stale_timestamp",
      });
      return false;
    }

    try {
      const signed = Buffer.concat([
        Buffer.from(`${timestamp}|`, "utf8"),
        req.rawBody,
      ]);
      const ok = cryptoVerify(
        null,
        signed,
        telnyxPublicKey(env.TELNYX_PUBLIC_KEY),
        Buffer.from(signature, "base64"),
      );

      if (!ok) {
        log.warn(LogEvent.SMS_WEBHOOK_SIGNATURE_INVALID, {
          provider: "telnyx",
          reason: "bad_signature",
        });
      }
      return ok;
    } catch (error) {
      log.warn(LogEvent.SMS_WEBHOOK_SIGNATURE_INVALID, {
        provider: "telnyx",
        reason: "verify_threw",
        error: String(error),
      });
      return false;
    }
  }

  parseWebhook(req: SmsWebhookRequest): SmsWebhookEvent | null {
    let envelope: TelnyxEnvelope;
    try {
      envelope = JSON.parse(req.rawBody.toString("utf8")) as TelnyxEnvelope;
    } catch {
      return null;
    }

    const eventType = envelope.data?.event_type;
    const payload = envelope.data?.payload;
    const providerMessageId = payload?.id;
    if (!eventType || !providerMessageId) return null;

    if (eventType === "message.received") {
      const from = payload?.from?.phone_number;
      const to = payload?.to?.[0]?.phone_number;
      if (!from || !to) return null;
      return {
        kind: "inbound",
        from,
        to,
        body: payload?.text ?? "",
        providerMessageId,
      };
    }

    if (eventType !== "message.sent" && eventType !== "message.finalized") {
      return null;
    }

    const recipients = payload?.to ?? [];
    if (recipients.length > 1) {
      // We always send to one. Reading only the first would silently drop the
      // rest, so say so rather than pretend.
      log.warn(LogEvent.SMS_STATUS_UNMAPPED, {
        provider: "telnyx",
        reason: "multiple_recipients",
        count: recipients.length,
      });
    }

    // The STATUS is per recipient. `event_type` only selects status-vs-inbound
    // — treating it as the status would mark everything `sent` and nothing
    // `delivered`, and would look entirely plausible in a log.
    const rawStatus = recipients[0]?.status ?? "queued";
    const mapped = STATUS_MAP[rawStatus];

    const firstError = payload?.errors?.[0];
    const errorCode =
      firstError?.code !== undefined ? String(firstError.code) : undefined;
    const errorMessage = [firstError?.title, firstError?.detail]
      .filter(Boolean)
      .join(" — ");

    return {
      kind: "status",
      providerMessageId,
      status: mapped ?? "queued",
      providerStatus: rawStatus,
      unmapped: mapped === undefined,
      ...(errorCode ? { errorCode } : {}),
      ...(errorMessage ? { errorMessage } : {}),
      ...(recipients[0]?.phone_number ? { to: recipients[0].phone_number } : {}),
      ...(errorCode === OPTED_OUT_ERROR
        ? { optOut: { source: "telnyx_40300" } }
        : {}),
    };
  }

  /**
   * Telnyx has no TwiML equivalent — a reply is an ordinary outbound message,
   * and the webhook itself just gets a bare 200.
   */
  async respondToInbound(
    reply: string | null,
    to: string | null,
  ): Promise<SmsWebhookResponse> {
    if (reply && to) {
      try {
        await this.sendSms({ to, body: reply });
      } catch (error) {
        // Deliberately swallowed. A non-2xx here makes Telnyx redeliver the
        // INBOUND message, which re-runs the consent logic — a redelivery storm
        // on a STOP handler is far worse than a missed HELP reply.
        log.failure(LogEvent.SMS_HELP_REPLY_FAILED, error, {
          provider: "telnyx",
          toMasked: maskPhone(to),
        });
      }
    }
    return { status: 200, contentType: "text/plain", body: "" };
  }
}

/**
 * The portal hands out a base64 RAW 32-byte Ed25519 key, but `crypto.verify`
 * needs a KeyObject. Wrapping it in the fixed SPKI DER prefix is the whole
 * conversion — the prefix encodes "this is an Ed25519 public key" and never
 * varies.
 */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

let cachedKey: { raw: string; key: ReturnType<typeof createPublicKey> } | null =
  null;

const telnyxPublicKey = (raw: string) => {
  if (cachedKey?.raw === raw) return cachedKey.key;
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw, "base64")]),
    format: "der",
    type: "spki",
  });
  cachedKey = { raw, key };
  return key;
};
