import { and, eq, sql } from "drizzle-orm";
import { Webhook } from "svix";
import { env } from "../config/env";
import { systemDb } from "../db/client";
import { notifications } from "../db/schema/notifications";
import { smsInboundMessages } from "../db/schema/sms-inbound-messages";
import { toE164 } from "../utils/phone";
import {
  applyGlobalOptIn,
  applyGlobalOptOut,
  suppressEmail,
  unsuppressEmail,
} from "./consent.service";
import { classifyKeyword, HELP_REPLY } from "./sms/keywords";
import { getSmsProvider } from "./sms/sms.provider";

/**
 * Delivery callbacks from Twilio and Resend.
 *
 * These endpoints are public and unauthenticated, so the SIGNATURE is the
 * credential — and they reach `systemDb` with no request context, meaning RLS
 * does not apply to anything here. Every write below therefore carries an
 * explicit predicate: a provider message id, a normalised phone, or a
 * lowercased email. Nothing is scoped by ambient tenancy, because there is
 * none.
 *
 * Two rules apply to both providers:
 *
 *   Never regress a terminal status. Webhook ordering is not guaranteed, and a
 *   late "sent" arriving after "delivered" must not undo the delivery.
 *
 *   Never 4xx a verified-but-unrecognised event. A non-2xx tells the provider
 *   to retry, and retrying something we will never recognise means retrying
 *   forever.
 */

// ─── Twilio: status callbacks ─────────────────────────────────────────────────

/**
 * Twilio's terminal error for sending to a number that has opted out.
 *
 * Handled as a second, independent opt-out path: when Advanced Opt-Out absorbs
 * a STOP at the carrier level, it may never forward the inbound message to us,
 * and this error is then the only signal that our consent columns are stale.
 */
const TWILIO_OPTED_OUT_ERROR = "21610";

const STATUS_MAP: Record<string, "sent" | "delivered" | "failed"> = {
  sent: "sent",
  delivered: "delivered",
  undelivered: "failed",
  failed: "failed",
};

export type TwilioStatusResult = {
  handled: boolean;
  reason?: string;
};

export const handleTwilioStatusCallback = async (
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<TwilioStatusResult> => {
  const provider = getSmsProvider();

  if (!provider.verifyWebhook(url, params, signature)) {
    // Thrown, not returned: an unverifiable payload is the one case that must
    // NOT get a 2xx, because accepting it would let anyone on the internet mark
    // messages delivered or opt numbers out.
    throw new Error("Invalid Twilio signature");
  }

  const event = provider.parseStatusCallback(params);
  if (!event) return { handled: false, reason: "unrecognised payload" };

  const mapped = STATUS_MAP[event.status];

  // queued / sending / accepted are progress, not outcomes. Recorded as the
  // provider's own word without touching our status.
  if (!mapped) {
    await systemDb
      .update(notifications)
      .set({ providerStatus: event.status, updatedAt: new Date() })
      .where(eq(notifications.providerMessageId, event.providerMessageId));
    return { handled: true, reason: `non-terminal status ${event.status}` };
  }

  const failureReason =
    mapped === "failed"
      ? [event.errorCode, event.errorMessage].filter(Boolean).join(": ") ||
        "delivery failed"
      : null;

  await systemDb
    .update(notifications)
    .set({
      status: mapped,
      providerStatus: event.status,
      ...(mapped === "delivered" ? { deliveredAt: new Date() } : {}),
      ...(failureReason ? { failureReason } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notifications.providerMessageId, event.providerMessageId),
        // Never walk back a delivery.
        sql`${notifications.status} <> 'delivered'`,
      ),
    );

  if (event.errorCode === TWILIO_OPTED_OUT_ERROR) {
    const phone = event.to ?? params.To;
    if (phone) await applyGlobalOptOut(phone, "twilio_21610");
  }

  return { handled: true };
};

// ─── Twilio: inbound messages ─────────────────────────────────────────────────

export type TwilioInboundResult = {
  keyword: string | null;
  /** TwiML body to reply with, or null to reply with an empty response. */
  reply: string | null;
};

export const handleTwilioInbound = async (
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<TwilioInboundResult> => {
  const provider = getSmsProvider();

  if (!provider.verifyWebhook(url, params, signature)) {
    throw new Error("Invalid Twilio signature");
  }

  const event = provider.parseInbound(params);
  if (!event) return { keyword: null, reply: null };

  const keyword = classifyKeyword(event.body);
  const fromE164 = toE164(event.from) ?? event.from;

  /**
   * Recorded before acting, and unique on the provider id.
   *
   * The insert is the idempotency guard: Twilio's webhook is at-least-once, and
   * a redelivered STOP must not double-count the rows it affected. A conflict
   * means we have already handled this message.
   */
  const [recorded] = await systemDb
    .insert(smsInboundMessages)
    .values({
      fromPhone: fromE164,
      toPhone: toE164(event.to) ?? event.to,
      body: event.body,
      keyword,
      providerMessageId: event.providerMessageId,
    })
    .onConflictDoNothing()
    .returning({ id: smsInboundMessages.id });

  if (!recorded) {
    return {
      keyword,
      // Still replies to a redelivered HELP: the carrier requirement is about
      // what the sender receives, not about our bookkeeping.
      reply: keyword === "HELP" ? HELP_REPLY : null,
    };
  }

  if (keyword === "STOP") {
    const affected = await applyGlobalOptOut(fromE164, "sms_stop");
    await systemDb
      .update(smsInboundMessages)
      .set({ affected })
      .where(eq(smsInboundMessages.id, recorded.id));
    // No reply. Twilio's Advanced Opt-Out sends the compliant confirmation, and
    // a second message to someone who just asked us to stop is exactly what
    // they asked us not to do.
    return { keyword, reply: null };
  }

  if (keyword === "START") {
    const affected = await applyGlobalOptIn(fromE164, "sms_start");
    await systemDb
      .update(smsInboundMessages)
      .set({ affected })
      .where(eq(smsInboundMessages.id, recorded.id));
    return { keyword, reply: null };
  }

  if (keyword === "HELP") {
    return { keyword, reply: HELP_REPLY };
  }

  // A message that is not a keyword. Kept as a record — the firm has no SMS
  // inbox, so this is the only place it exists — but nothing is sent back.
  return { keyword: null, reply: null };
};

// ─── Resend: email delivery ───────────────────────────────────────────────────

type ResendEvent = {
  type: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
    [key: string]: unknown;
  };
};

export type ResendWebhookResult = {
  handled: boolean;
  type?: string;
  reason?: string;
};

/**
 * Verify and apply a Resend delivery event.
 *
 * Resend signs with Svix over the RAW request body — the opposite of Twilio,
 * which signs the URL and sorted params. That is why /webhooks/resend gets
 * express.raw() in app.ts while /webhooks/twilio gets express.urlencoded(),
 * both before express.json().
 *
 * The svix library also enforces a timestamp tolerance, which is what defeats
 * replay of a captured payload.
 */
export const handleResendWebhook = async (
  rawBody: Buffer,
  headers: Record<string, string>,
): Promise<ResendWebhookResult> => {
  if (!env.RESEND_WEBHOOK_SECRET) {
    throw new Error("Resend webhook secret is not configured");
  }

  const webhook = new Webhook(env.RESEND_WEBHOOK_SECRET);

  // Throws on a bad signature or a stale timestamp; the route lets it 4xx.
  const event = webhook.verify(rawBody.toString("utf8"), headers) as ResendEvent;

  const emailId = event.data?.email_id;
  const recipient = Array.isArray(event.data?.to)
    ? event.data?.to[0]
    : event.data?.to;

  switch (event.type) {
    case "email.sent":
      await updateByEmailId(emailId, {
        status: "sent",
        sentAt: new Date(),
        providerStatus: event.type,
      });
      return { handled: true, type: event.type };

    case "email.delivered":
      await updateByEmailId(emailId, {
        status: "delivered",
        deliveredAt: new Date(),
        providerStatus: event.type,
      });
      return { handled: true, type: event.type };

    case "email.delivery_delayed":
      // Not a failure — the provider is still retrying. Only the raw status
      // moves, so a temporarily-delayed message does not read as bounced.
      await updateByEmailId(emailId, { providerStatus: event.type });
      return { handled: true, type: event.type };

    case "email.bounced": {
      const detail =
        event.data?.bounce?.message ??
        event.data?.bounce?.subType ??
        event.data?.bounce?.type ??
        "bounced";
      await updateByEmailId(emailId, {
        status: "failed",
        failureReason: String(detail).slice(0, 500),
        providerStatus: event.type,
      });
      // Suppress so we stop sending. Continuing to mail a hard-bounced address
      // is what gets a sending domain throttled, and the domain is shared by
      // every firm on the platform.
      if (recipient) await suppressEmail(recipient, "bounced", emailId);
      return { handled: true, type: event.type };
    }

    case "email.complained":
      await updateByEmailId(emailId, {
        status: "failed",
        failureReason: "spam_complaint",
        providerStatus: event.type,
      });
      if (recipient) await suppressEmail(recipient, "complained", emailId);
      return { handled: true, type: event.type };

    case "email.failed":
      await updateByEmailId(emailId, {
        status: "failed",
        failureReason: "provider reported failure",
        providerStatus: event.type,
      });
      return { handled: true, type: event.type };

    case "email.suppressed":
      // Resend refused to send because the address is on its suppression list.
      // Our mirror was evidently out of date, so bring it into line.
      await updateByEmailId(emailId, {
        status: "skipped",
        skipReason: "email_suppressed_provider",
        providerStatus: event.type,
      });
      if (recipient)
        await suppressEmail(recipient, "provider_suppressed", emailId);
      return { handled: true, type: event.type };

    case "suppression.added":
      if (recipient)
        await suppressEmail(recipient, "provider_suppressed", emailId);
      return { handled: true, type: event.type };

    case "suppression.removed":
      if (recipient) await unsuppressEmail(recipient);
      return { handled: true, type: event.type };

    default:
      // email.opened / email.clicked are ignored deliberately: open tracking is
      // unreliable (mail-proxy prefetch inflates it) and click tracking rewrites
      // links, which is a poor fit for links into a law firm's client portal.
      // Domain and contact events are not ours to act on.
      return { handled: false, type: event.type, reason: "ignored event type" };
  }
};

const updateByEmailId = async (
  emailId: string | undefined,
  patch: Record<string, unknown>,
): Promise<void> => {
  if (!emailId) return;

  await systemDb
    .update(notifications)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(notifications.providerMessageId, emailId),
        // Same rule as the Twilio path: a late event must not undo a delivery.
        sql`${notifications.status} <> 'delivered'`,
      ),
    );
};
