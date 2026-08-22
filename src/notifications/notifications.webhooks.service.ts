import { and, eq, sql } from "drizzle-orm";
import { Webhook } from "svix";
import { env } from "../config/env";
import { systemDb } from "../db/client";
import { notifications } from "../db/schema/notifications";
import { smsInboundMessages } from "../db/schema/sms-inbound-messages";
import { maskPhone, toE164 } from "../utils/phone";
import { createModuleLogger, LogEvent } from "../lib/logging/log";
import {
  applyGlobalOptIn,
  applyGlobalOptOut,
  suppressEmail,
  unsuppressEmail,
} from "./consent.service";
import { classifyKeyword, HELP_REPLY } from "./sms/keywords";
import type {
  SmsProvider,
  SmsWebhookEvent,
  SmsWebhookRequest,
  SmsWebhookResponse,
} from "./sms/sms.provider";

const log = createModuleLogger("notifications.webhooks_service");

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

// ─── SMS: status callbacks and inbound ───────────────────────────────────────

/** Thrown on an unverifiable payload — the one case that must NOT get a 2xx. */
export class SmsWebhookVerificationError extends Error {
  constructor(provider: string) {
    super(`Invalid ${provider} webhook signature`);
    this.name = "SmsWebhookVerificationError";
  }
}

export type SmsWebhookResult = {
  handled: boolean;
  kind?: "status" | "inbound";
  keyword?: string | null;
  reason?: string;
  /** Built by the provider; the route writes it verbatim. */
  response: SmsWebhookResponse;
};

/**
 * One handler for both callback kinds and every provider.
 *
 * The provider is passed IN rather than resolved from env: a route bound to
 * Twilio must keep verifying Twilio callbacks even while SMS_PROVIDER says
 * telnyx, or a switchover silently discards in-flight status callbacks — and
 * with them the opted-out error code that is often the only signal a recipient
 * said STOP.
 */
export const handleSmsWebhook = async (
  provider: SmsProvider,
  req: SmsWebhookRequest,
): Promise<SmsWebhookResult> => {
  if (!provider.verifyWebhook(req)) {
    throw new SmsWebhookVerificationError(provider.name);
  }

  const event = provider.parseWebhook(req);
  if (!event) {
    return {
      handled: false,
      reason: "unrecognised payload",
      response: { status: 204, contentType: "text/plain", body: "" },
    };
  }

  if (event.kind === "status") {
    return handleStatus(provider, event);
  }

  return handleInbound(provider, event);
};

const handleStatus = async (
  provider: SmsProvider,
  event: Extract<SmsWebhookEvent, { kind: "status" }>,
): Promise<SmsWebhookResult> => {
  const ack: SmsWebhookResponse = {
    status: 204,
    contentType: "text/plain",
    body: "",
  };

  // A word the provider does not recognise is progress, not an outcome. Logged
  // rather than swallowed, so a vendor adding a status is something you can
  // alert on instead of a row that quietly never moves again.
  if (event.unmapped) {
    log.warn(LogEvent.SMS_STATUS_UNMAPPED, {
      provider: provider.name,
      providerStatus: event.providerStatus,
      providerMessageId: event.providerMessageId,
    });
  }

  // queued/sending are progress, not outcomes: record the provider's own word
  // without touching our status.
  if (event.status === "queued" || event.unmapped) {
    await systemDb
      .update(notifications)
      .set({ providerStatus: event.providerStatus, updatedAt: new Date() })
      .where(eq(notifications.providerMessageId, event.providerMessageId));
  } else {
    const failureReason =
      event.status === "failed"
        ? [event.errorCode, event.errorMessage].filter(Boolean).join(": ") ||
          "delivery failed"
        : null;

    await systemDb
      .update(notifications)
      .set({
        status: event.status,
        providerStatus: event.providerStatus,
        ...(event.status === "delivered" ? { deliveredAt: new Date() } : {}),
        ...(failureReason ? { failureReason } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(notifications.providerMessageId, event.providerMessageId),
          // Never walk back a delivery — callbacks arrive out of order.
          sql`${notifications.status} <> 'delivered'`,
        ),
      );
  }

  // The provider decided this error means "opted out"; the vendor's code and
  // its recorded source stay entirely behind that decision.
  if (event.optOut && event.to) {
    await applyGlobalOptOut(event.to, event.optOut.source);
  }

  return { handled: true, kind: "status", response: ack };
};

const handleInbound = async (
  provider: SmsProvider,
  event: Extract<SmsWebhookEvent, { kind: "inbound" }>,
): Promise<SmsWebhookResult> => {
  const keyword = classifyKeyword(event.body);
  const fromE164 = toE164(event.from) ?? event.from;

  log.info(LogEvent.SMS_INBOUND_RECEIVED, {
    provider: provider.name,
    keyword,
    fromMasked: maskPhone(fromE164),
  });

  /**
   * Recorded before acting, and unique on the provider id.
   *
   * The insert is the idempotency guard: every provider's webhook is
   * at-least-once, and a redelivered STOP must not double-count the rows it
   * affected.
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

  const reply = keyword === "HELP" ? HELP_REPLY : null;

  if (!recorded) {
    // Still replies to a redelivered HELP: the carrier requirement is about
    // what the sender receives, not about our bookkeeping.
    return {
      handled: true,
      kind: "inbound",
      keyword,
      response: await provider.respondToInbound(reply, fromE164),
    };
  }

  if (keyword === "STOP" || keyword === "START") {
    const affected =
      keyword === "STOP"
        ? await applyGlobalOptOut(fromE164, "sms_stop")
        : await applyGlobalOptIn(fromE164, "sms_start");

    await systemDb
      .update(smsInboundMessages)
      .set({ affected })
      .where(eq(smsInboundMessages.id, recorded.id));
  }

  // No reply to a STOP: the provider's own opt-out handling sends the
  // compliant confirmation, and a second message to someone who just asked us
  // to stop is precisely what they asked us not to do.
  return {
    handled: true,
    kind: "inbound",
    keyword,
    response: await provider.respondToInbound(reply, fromE164),
  };
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
