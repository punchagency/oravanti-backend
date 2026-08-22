/**
 * Notification layer: phone normalisation, firm preferences, and the event
 * catalog.
 *
 * Grows alongside the feature — each phase adds its own section, so a phase can
 * be verified without waiting for the ones after it.
 *
 *   npm run check 13-notifications
 */
import { createHmac, generateKeyPairSync, sign } from "crypto";
import { and, eq } from "drizzle-orm";
import { Webhook } from "svix";
import { env } from "../../src/config/env";
import { systemDb } from "../../src/db/client";
import { smsInboundMessages } from "../../src/db/schema/sms-inbound-messages";
import { consultationSettings } from "../../src/db/schema/consultation-settings";
import { consultations } from "../../src/db/schema/consultations";
import { emailSuppressions } from "../../src/db/schema/email-suppressions";
import { leads } from "../../src/db/schema/leads";
import { notifications } from "../../src/db/schema/notifications";
import {
  getEmailSuppression,
  suppressEmail,
  unsuppressEmail,
} from "../../src/notifications/consent.service";
import {
  cancelConsultationReminders,
  scheduleConsultationReminders,
} from "../../src/notifications/consultation-reminders";
import { notify } from "../../src/notifications/notification.service";
import {
  handleResendWebhook,
  handleSmsWebhook,
} from "../../src/notifications/notifications.webhooks.service";
import { resolveChannelDecision } from "../../src/notifications/preferences.service";
import { classifyKeyword } from "../../src/notifications/sms/keywords";
import {
  getSmsProvider,
  getSmsProviderByName,
  isSmsProviderConfigured,
  resetSmsProviderCache,
  type SmsProviderName,
  type SmsWebhookRequest,
} from "../../src/notifications/sms/sms.provider";
import { dispatchNotification } from "../../src/queue/workers/notification.worker";
import { emailService } from "../../src/utils/email/email.service";
import {
  notificationPreferences,
  notificationSettings,
} from "../../src/db/schema/notification-settings";
import {
  DEFAULT_CHANNEL_PREFERENCES,
  FIRM_PREFERENCE_EVENTS,
  FIRM_PREFERENCE_LABELS,
  isFirmPreferenceEvent,
  NOTIFICATION_EVENTS,
  type NotificationEventKey,
} from "../../src/notifications/events";
import {
  escapeHtml,
  gsmSegments,
  html,
  raw,
  smsBody,
} from "../../src/notifications/render";
import { TEMPLATES } from "../../src/notifications/templates";
import { NotificationSettingsService } from "../../src/modules/settings/notifications/notification-settings.service";
import { updateNotificationSettingsSchema } from "../../src/modules/settings/notifications/notification-settings.validation";
import { isE164, maskPhone, toE164 } from "../../src/utils/phone";
import { check, checkEqual, report, section, withTempFixture, withOrgContext } from "./_bootstrap";

/**
 * Reproduces Twilio's request signature: HMAC-SHA1, base64, over the URL
 * followed by each form parameter sorted by key and concatenated as key+value.
 *
 * Written out rather than imported from the SDK on purpose — using the same
 * helper to sign and to verify would pass even if both were wrong. This is the
 * documented algorithm, so the provider is checked against the spec.
 */
const twilioSignature = (
  authToken: string,
  url: string,
  params: Record<string, string>,
): string => {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  return createHmac("sha1", authToken).update(Buffer.from(payload, "utf-8")).digest("base64");
};


// ─── SMS webhook fixtures ─────────────────────────────────────────────────────

/** Fixed dummy credentials, so assertions mean the same thing on every machine. */
const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: "ACcheck",
  TWILIO_AUTH_TOKEN: "check-auth-token",
  TWILIO_FROM_NUMBER: "+15005550006",
  TWILIO_WEBHOOK_BASE_URL: "https://api.example.test",
};

/** One Ed25519 keypair per run — no secret is hardcoded and the real path runs. */
const telnyxKeys = generateKeyPairSync("ed25519");
const telnyxPublicKeyB64 = telnyxKeys.publicKey
  .export({ format: "der", type: "spki" })
  // Strip the 12-byte SPKI prefix: the portal hands out the raw 32 bytes.
  .subarray(12)
  .toString("base64");

const telnyxEnv = () => ({
  TELNYX_API_KEY: "KEYcheck",
  TELNYX_MESSAGING_PROFILE_ID: "MPcheck",
  TELNYX_PUBLIC_KEY: telnyxPublicKeyB64,
  TELNYX_WEBHOOK_BASE_URL: "https://api.example.test",
});

/**
 * Install SMS env for the duration of `fn` and restore it afterwards.
 *
 * Every SMS_/TWILIO_/TELNYX_ key is snapshotted, not just the ones being set:
 * with two providers there are a dozen, and a missed restore leaks into the
 * dispatch and resend sections later in the same run, producing a failure that
 * points at the wrong code.
 */
const SMS_ENV_KEYS = [
  "SMS_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_FROM_NUMBER",
  "TWILIO_WEBHOOK_BASE_URL",
  "TELNYX_API_KEY",
  "TELNYX_MESSAGING_PROFILE_ID",
  "TELNYX_FROM_NUMBER",
  "TELNYX_PUBLIC_KEY",
  "TELNYX_WEBHOOK_BASE_URL",
] as const;

const withSmsEnv = async <T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> => {
  const mutable = env as Record<string, unknown>;
  const snapshot = Object.fromEntries(SMS_ENV_KEYS.map((k) => [k, mutable[k]]));
  for (const k of SMS_ENV_KEYS) delete mutable[k];
  for (const [k, v] of Object.entries(vars)) if (v) mutable[k] = v;
  resetSmsProviderCache();
  try {
    return await fn();
  } finally {
    for (const k of SMS_ENV_KEYS) delete mutable[k];
    for (const [k, v] of Object.entries(snapshot)) if (v !== undefined) mutable[k] = v;
    resetSmsProviderCache();
  }
};

type StatusInput = {
  messageId: string;
  status: string;
  to: string;
  errorCode?: string;
};
type InboundInput = {
  messageId: string;
  from: string;
  to: string;
  body: string;
};

type SmsFixture = {
  name: SmsProviderName;
  env: Record<string, string>;
  url: string;
  status(i: StatusInput): SmsWebhookRequest;
  inbound(i: InboundInput): SmsWebhookRequest;
  /** Provider words, so the shared assertions can speak one language. */
  words: { queued: string; sent: string; delivered: string; failed: string };
  /** Every status word the vendor publishes — all must map. */
  vocabulary: string[];
  optedOutCode: string;
  optOutSource: string;
  /** Provider-specific forgery cases. */
  negatives: { label: string; mutate(r: SmsWebhookRequest): SmsWebhookRequest }[];
};

const twilioFixture = (): SmsFixture => {
  const url = "https://api.example.test/webhooks/twilio";
  const form = (params: Record<string, string>) =>
    Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
  const build = (suffix: string, params: Record<string, string>): SmsWebhookRequest => ({
    rawBody: Buffer.from(form(params), "utf8"),
    headers: {
      "x-twilio-signature": twilioSignature(
        TWILIO_ENV.TWILIO_AUTH_TOKEN,
        `${url}${suffix}`,
        params,
      ),
      "content-type": "application/x-www-form-urlencoded",
    },
    url: `${url}${suffix}`,
  });

  return {
    name: "twilio",
    env: { SMS_PROVIDER: "twilio", ...TWILIO_ENV },
    url,
    status: (i) =>
      build("/status", {
        MessageSid: i.messageId,
        MessageStatus: i.status,
        To: i.to,
        ...(i.errorCode ? { ErrorCode: i.errorCode } : {}),
      }),
    inbound: (i) =>
      build("/inbound", {
        MessageSid: i.messageId,
        From: i.from,
        To: i.to,
        Body: i.body,
      }),
    words: { queued: "queued", sent: "sent", delivered: "delivered", failed: "failed" },
    vocabulary: [
      "queued", "accepted", "scheduled", "sending",
      "sent", "delivered", "read", "undelivered", "failed",
    ],
    optedOutCode: "21610",
    optOutSource: "twilio_21610",
    negatives: [
      {
        // The concrete reason TWILIO_WEBHOOK_BASE_URL exists rather than being
        // rebuilt from req.protocol.
        label: "a different URL invalidates the signature",
        mutate: (r) => ({ ...r, url: r.url.replace("https", "http") }),
      },
      {
        label: "a tampered body invalidates the signature",
        mutate: (r) => ({
          ...r,
          rawBody: Buffer.from(
            r.rawBody.toString("utf8").replace("delivered", "failed"),
            "utf8",
          ),
        }),
      },
    ],
  };
};

const telnyxFixture = (): SmsFixture => {
  const url = "https://api.example.test/webhooks/telnyx";
  const build = (payload: unknown): SmsWebhookRequest => {
    const raw = Buffer.from(JSON.stringify(payload), "utf8");
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(`${ts}|`, "utf8"), raw]),
      telnyxKeys.privateKey,
    ).toString("base64");
    return {
      rawBody: raw,
      headers: {
        "telnyx-signature-ed25519": signature,
        "telnyx-timestamp": ts,
        "content-type": "application/json",
      },
      url,
    };
  };

  return {
    name: "telnyx",
    env: { SMS_PROVIDER: "telnyx", ...telnyxEnv() },
    url,
    status: (i) =>
      build({
        data: {
          event_type: "message.finalized",
          payload: {
            id: i.messageId,
            to: [{ phone_number: i.to, status: i.status }],
            ...(i.errorCode
              ? { errors: [{ code: i.errorCode, title: "Blocked", detail: "STOP" }] }
              : {}),
          },
        },
      }),
    inbound: (i) =>
      build({
        data: {
          event_type: "message.received",
          payload: {
            id: i.messageId,
            text: i.body,
            from: { phone_number: i.from },
            to: [{ phone_number: i.to }],
          },
        },
      }),
    words: {
      queued: "queued",
      sent: "sent",
      delivered: "delivered",
      failed: "delivery_failed",
    },
    vocabulary: [
      "queued", "sending", "sent", "delivered",
      "delivery_unconfirmed", "sending_failed", "delivery_failed", "expired",
    ],
    optedOutCode: "40300",
    optOutSource: "telnyx_40300",
    negatives: [
      {
        label: "a tampered body invalidates the signature",
        mutate: (r) => ({
          ...r,
          rawBody: Buffer.from(
            r.rawBody.toString("utf8").replace("delivered", "delivery_failed"),
            "utf8",
          ),
        }),
      },
      {
        // The timestamp is what defeats replay of a captured payload.
        label: "a stale timestamp is rejected",
        mutate: (r) => ({
          ...r,
          headers: {
            ...r.headers,
            "telnyx-timestamp": String(Math.floor(Date.now() / 1000) - 3600),
          },
        }),
      },
    ],
  };
};



/**
 * Every DB assertion, run once per provider.
 *
 * Labels are prefixed with the provider name so a failure says which vendor
 * broke. Nothing in here knows a vendor's wire format — that is entirely the
 * fixture's job, which is the point.
 */
const runSmsWebhookSuite = async (fx: SmsFixture) => {
  const t = (label: string) => `[${fx.name}] ${label}`;

  await withTempFixture({}, async (fixture) => {
    const orgId = fixture.organizationId;
    const messageId = `msg-${fx.name}-${Date.now()}`;
    const phone = "+14155552671";

    const [row] = await systemDb
      .insert(notifications)
      .values({
        organizationId: orgId,
        event: "questionnaire_sent",
        tier: "transactional",
        channel: "sms",
        status: "sent",
        recipientType: "lead",
        recipientId: fixture.leadId,
        recipientAddress: phone,
        providerMessageId: messageId,
        sentAt: new Date(),
      })
      .returning();

    // The stub verifies nothing — an unconfigured deployment must never accept
    // a forged callback.
    await withSmsEnv({}, async () => {
      check(
        t("an unconfigured provider does not resolve for its own route"),
        getSmsProviderByName(fx.name) === null,
      );
    });

    await withSmsEnv(fx.env, async () => {
      const provider = getSmsProviderByName(fx.name)!;
      check(t("the provider resolves by name"), provider.name === fx.name);

      // ── Vocabulary ────────────────────────────────────────────────────────
      // A vendor adding a status word becomes a red check rather than a row
      // that quietly never moves again.
      const unmapped = fx.vocabulary.filter((word) => {
        const parsed = provider.parseWebhook(
          fx.status({ messageId, status: word, to: phone }),
        );
        return parsed?.kind === "status" ? parsed.unmapped : true;
      });
      check(t("every published status word maps"), unmapped.length === 0, unmapped);

      // ── Signature ─────────────────────────────────────────────────────────
      check(
        t("a valid signature verifies"),
        provider.verifyWebhook(
          fx.status({ messageId, status: fx.words.delivered, to: phone }),
        ),
      );
      for (const negative of fx.negatives) {
        check(
          t(negative.label),
          !provider.verifyWebhook(
            negative.mutate(
              fx.status({ messageId, status: fx.words.delivered, to: phone }),
            ),
          ),
        );
      }

      // ── Status callbacks ──────────────────────────────────────────────────
      await handleSmsWebhook(
        provider,
        fx.status({ messageId, status: fx.words.delivered, to: phone }),
      );
      let [after] = await systemDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, row.id));
      checkEqual(t("delivered is applied"), after.status, "delivered");
      check(t("deliveredAt is stamped"), after.deliveredAt !== null);

      // Out-of-order callbacks are normal; a late 'sent' must not undo it.
      await handleSmsWebhook(
        provider,
        fx.status({ messageId, status: fx.words.sent, to: phone }),
      );
      [after] = await systemDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, row.id));
      checkEqual(t("a late sent does not regress a delivery"), after.status, "delivered");

      // An unverifiable payload must throw — it is the one case that must not
      // get a 2xx.
      let rejected = false;
      await handleSmsWebhook(provider, {
        ...fx.status({ messageId, status: fx.words.delivered, to: phone }),
        headers: {},
      }).catch(() => {
        rejected = true;
      });
      check(t("an unsigned payload is rejected"), rejected);

      // ── Inbound STOP / START ──────────────────────────────────────────────
      await systemDb
        .update(leads)
        .set({ phone, smsConsent: true, smsOptOutAt: null })
        .where(eq(leads.id, fixture.leadId));

      const stopId = `${messageId}-stop`;
      const stopResult = await handleSmsWebhook(
        provider,
        // Deliberately a differently-formatted number: matching is on the
        // normalised form, or an opt-out would be missed.
        fx.inbound({ messageId: stopId, from: "+1 (415) 555-2671", to: phone, body: "STOP" }),
      );
      checkEqual(t("inbound STOP is classified"), stopResult.keyword, "STOP");

      let [lead] = await systemDb
        .select()
        .from(leads)
        .where(eq(leads.id, fixture.leadId));
      checkEqual(t("STOP clears consent"), lead.smsConsent, false);
      check(t("STOP stamps the opt-out date"), lead.smsOptOutAt !== null);

      const [inboundRow] = await systemDb
        .select()
        .from(smsInboundMessages)
        .where(eq(smsInboundMessages.providerMessageId, stopId));
      checkEqual(t("the inbound phone is stored E.164"), inboundRow.fromPhone, phone);
      checkEqual(
        t("the opt-out records what it affected"),
        (inboundRow.affected as { leads?: number }).leads,
        1,
      );

      // At-least-once delivery: the unique provider id makes a redelivery a
      // no-op rather than double-counting.
      await handleSmsWebhook(
        provider,
        fx.inbound({ messageId: stopId, from: phone, to: phone, body: "STOP" }),
      );
      const dupes = await systemDb
        .select()
        .from(smsInboundMessages)
        .where(eq(smsInboundMessages.providerMessageId, stopId));
      checkEqual(t("a redelivered STOP writes no second row"), dupes.length, 1);

      await handleSmsWebhook(
        provider,
        fx.inbound({ messageId: `${messageId}-start`, from: phone, to: phone, body: "start" }),
      );
      [lead] = await systemDb
        .select()
        .from(leads)
        .where(eq(leads.id, fixture.leadId));
      checkEqual(t("START restores consent"), lead.smsConsent, true);
      checkEqual(t("START clears the opt-out"), lead.smsOptOutAt, null);
      checkEqual(t("START records its source"), lead.smsConsentSource, "sms_start");

      // ── HELP ──────────────────────────────────────────────────────────────
      // Twilio replies inline as TwiML; Telnyx has no such mechanism and must
      // send an ordinary outbound message. The fetch is stubbed so the check
      // never touches the network.
      const realFetch = globalThis.fetch;
      let outboundSends = 0;
      globalThis.fetch = (async () => {
        outboundSends += 1;
        return new Response(
          JSON.stringify({ data: { id: "resp", to: [{ status: "queued" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      try {
        const helpResult = await handleSmsWebhook(
          provider,
          fx.inbound({ messageId: `${messageId}-help`, from: phone, to: phone, body: "HELP" }),
        );
        checkEqual(t("HELP is classified"), helpResult.keyword, "HELP");
        if (fx.name === "twilio") {
          check(
            t("HELP is answered inline as TwiML"),
            helpResult.response.body.includes("<Message>"),
          );
          checkEqual(t("HELP needs no outbound send"), outboundSends, 0);
        } else {
          checkEqual(t("HELP is answered by sending a message"), outboundSends, 1);
          checkEqual(t("and the webhook itself returns a bare 200"), helpResult.response.status, 200);
        }
      } finally {
        globalThis.fetch = realFetch;
      }

      // ── The opted-out error code ──────────────────────────────────────────
      // The second, independent opt-out path: both vendors absorb STOP at the
      // profile level and may never forward the inbound message.
      await handleSmsWebhook(
        provider,
        fx.status({
          messageId,
          status: fx.words.failed,
          to: phone,
          errorCode: fx.optedOutCode,
        }),
      );
      [lead] = await systemDb
        .select()
        .from(leads)
        .where(eq(leads.id, fixture.leadId));
      checkEqual(t("the opted-out error code clears consent"), lead.smsConsent, false);
      // The opt-out source ("twilio_21610" / "telnyx_40300") is logged, not
      // persisted: smsConsentSource records how consent was GIVEN, and
      // overloading it with how it was withdrawn would make neither readable.
      // What must persist is the decision itself.
      checkEqual(
        t("the opt-out survives as a cleared consent flag"),
        lead.smsConsent,
        false,
      );
      check(t("and stamps the opt-out date"), lead.smsOptOutAt !== null);
    });

    await systemDb
      .delete(smsInboundMessages)
      .where(eq(smsInboundMessages.fromPhone, phone));
  });
};


const main = async () => {
  // ─── Phone normalisation ───────────────────────────────────────────────────

  section("phone");

  checkEqual(
    "E.164 input passes through unchanged",
    toE164("+14155552671"),
    "+14155552671",
  );
  checkEqual(
    "spaced international number normalises",
    toE164("+1 415 555 2671"),
    "+14155552671",
  );
  checkEqual(
    "national number normalises with an explicit region",
    toE164("(415) 555-2671", "US"),
    "+14155552671",
  );
  checkEqual(
    "non-US number normalises",
    toE164("+44 20 7946 0958"),
    "+442079460958",
  );
  // The decision recorded in the plan: ambiguous input is skipped, never
  // guessed. A wrong guess texts a stranger.
  checkEqual("bare local number is unparseable", toE164("555-1234"), null);
  checkEqual(
    "bare local number stays unparseable even with a region",
    toE164("555-1234", "US"),
    null,
  );
  checkEqual("prose is unparseable", toE164("not a phone"), null);
  checkEqual("null is unparseable", toE164(null), null);
  checkEqual("empty string is unparseable", toE164("   "), null);

  check(
    "toE164 is idempotent",
    toE164(toE164("+1 415 555 2671")) === "+14155552671",
  );
  check("isE164 accepts normalised output", isE164(toE164("+1 415 555 2671")));
  check("isE164 rejects raw input", !isE164("415-555-2671"));
  checkEqual("maskPhone keeps only the last four", maskPhone("+14155552671"), "*******2671");

  // ─── Event catalog ─────────────────────────────────────────────────────────

  section("catalog");

  checkEqual(
    "ten firm preference events",
    FIRM_PREFERENCE_EVENTS.length,
    10,
  );
  check(
    "every preference event has a label",
    FIRM_PREFERENCE_EVENTS.every(
      (event) => FIRM_PREFERENCE_LABELS[event]?.length > 0,
    ),
  );
  check(
    "labels cover exactly the catalog",
    Object.keys(FIRM_PREFERENCE_LABELS).length === FIRM_PREFERENCE_EVENTS.length,
  );
  check("isFirmPreferenceEvent accepts a known key", isFirmPreferenceEvent("invoice_due"));
  check("isFirmPreferenceEvent rejects an unknown key", !isFirmPreferenceEvent("nope"));

  const eventKeys = Object.keys(NOTIFICATION_EVENTS) as NotificationEventKey[];

  check(
    "every preference-tier event names a prefKey in the ten",
    eventKeys.every((key) => {
      const def = NOTIFICATION_EVENTS[key];
      return (
        def.tier !== "preference" ||
        (def.prefKey !== undefined && isFirmPreferenceEvent(def.prefKey))
      );
    }),
  );
  check(
    "no transactional event carries a prefKey",
    eventKeys.every(
      (key) =>
        NOTIFICATION_EVENTS[key].tier !== "transactional" ||
        NOTIFICATION_EVENTS[key].prefKey === undefined,
    ),
  );

  // The assertion that catches a template someone forgot to write: an event
  // declaring a channel it cannot render would skip at send time with
  // `no_template` and look like a gating decision.
  const missingTemplates = eventKeys.flatMap((key) => {
    const def = NOTIFICATION_EVENTS[key];
    const template = TEMPLATES[key] ?? {};
    return def.channels
      .filter((channel) => {
        if (channel === "email") return !template.email;
        if (channel === "sms") return !template.sms;
        return !template.inApp;
      })
      .map((channel) => `${key}.${channel}`);
  });
  check(
    "every declared channel has a template",
    missingTemplates.length === 0,
    missingTemplates,
  );

  // Which of the ten toggles actually do something. Four describe things the
  // product does not detect yet; this pins the number so it can only go up.
  const wiredPrefKeys = new Set(
    eventKeys
      .map((key) => NOTIFICATION_EVENTS[key])
      .filter((def) => def.tier === "preference" && def.producer === "wired")
      .map((def) => def.prefKey!),
  );
  const unwired = FIRM_PREFERENCE_EVENTS.filter(
    (event) => !wiredPrefKeys.has(event),
  );
  checkEqual(
    "four of the ten firm toggles have a producer",
    FIRM_PREFERENCE_EVENTS.length - unwired.length,
    4,
  );
  /**
   * The six with no producer, and why — so this list is a record rather than a
   * mystery. Four describe things the product does not detect at all (RFEs,
   * certification expiry, leave decisions, inbound client messages).
   *
   * `invoice_due` needs a scheduled dunning job, which does not exist: the
   * finance module has aging data but chases are manual only, and
   * `payment_followup` is the manual chase, which is transactional and
   * therefore not governed by this toggle.
   *
   * `staff_leave_request` has a leave_requests table with a pending/approved
   * status and no notification on either transition.
   *
   * Update this list when one gets wired — it should only ever shrink.
   */
  checkEqual(
    "the unwired six are the ones with no producer",
    unwired.slice().sort().join(","),
    [
      "certification_expiring",
      "client_message_received",
      "deadline_approaching",
      "invoice_due",
      "rfe_noid_received",
      "staff_leave_request",
    ]
      .sort()
      .join(","),
  );

  // ─── Rendering ─────────────────────────────────────────────────────────────

  section("rendering");

  checkEqual(
    "html escapes interpolations by default",
    html`<p>${"<script>alert(1)</script>"}</p>`,
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
  checkEqual(
    "raw() opts out of escaping",
    html`<p>${raw("<b>bold</b>")}</p>`,
    "<p><b>bold</b></p>",
  );
  checkEqual("escapeHtml handles quotes", escapeHtml(`"x"`), "&quot;x&quot;");

  checkEqual("a short ASCII body is one segment", gsmSegments("hello"), 1);
  checkEqual("160 GSM-7 chars is one segment", gsmSegments("a".repeat(160)), 1);
  checkEqual("161 GSM-7 chars is two segments", gsmSegments("a".repeat(161)), 2);
  // The trap this exists to catch: one curly quote drops the limit to 70.
  checkEqual("a curly quote forces UCS-2", gsmSegments(`a`.repeat(71) + "’"), 2);

  checkEqual(
    "smsBody prefixes the firm name",
    smsBody("Acme Law", "Your link: x"),
    "Acme Law: Your link: x",
  );
  check(
    "smsBody truncates a long firm name",
    smsBody("A".repeat(40), "x").startsWith(`${"A".repeat(20)}: `),
  );

  // Every SMS template must fit one segment with a full-length firm prefix,
  // because a second segment doubles the per-message cost of every send.
  const firmName = "A".repeat(20);
  const smsMeta = {
    firmName,
    recipientName: "Jane Doe",
    appUrl: "https://app.example.com",
    timezone: "UTC",
  };
  const smsContext = {
    link: "https://app.example.com/q/abcd1234",
    when: "Tue 14 Aug, 2:30 PM EDT",
    amount: "$1,250.00",
    joinUrl: "https://meet.example.com/abc-defg-hij",
  };
  const oversized = eventKeys
    .filter((key) => TEMPLATES[key]?.sms)
    .map((key) => ({
      key,
      body: TEMPLATES[key]!.sms!(smsContext, smsMeta),
    }))
    .filter(({ body }) => gsmSegments(body) > 1)
    .map(({ key, body }) => `${key} (${[...body].length} chars)`);
  check("every SMS template fits one segment", oversized.length === 0, oversized);

  // ─── Preferences API ───────────────────────────────────────────────────────

  section("preferences");

  const service = new NotificationSettingsService();

  await withTempFixture({}, async (fixture) => {
    await withOrgContext(fixture.organizationId, fixture.userId, async () => {
      // Read with nothing saved.
      const initial = await service.getSettings(fixture.organizationId);

      checkEqual("unsaved firm returns all ten events", initial.preferences.length, 10);
      checkEqual("unsaved firm has no settings id", initial.id, "");
      checkEqual("unsaved firm has no updatedAt", initial.updatedAt, null);
      check(
        "unsaved firm gets the documented defaults",
        initial.preferences.every(
          (p) =>
            p.email === DEFAULT_CHANNEL_PREFERENCES.email &&
            p.sms === DEFAULT_CHANNEL_PREFERENCES.sms &&
            p.inApp === DEFAULT_CHANNEL_PREFERENCES.inApp,
        ),
      );
      checkEqual(
        "events come back in catalog order",
        initial.preferences.map((p) => p.event).join(","),
        FIRM_PREFERENCE_EVENTS.join(","),
      );

      // A read must not create rows — otherwise "has this firm ever configured
      // notifications?" becomes unanswerable.
      const rowsAfterRead = await systemDb
        .select()
        .from(notificationSettings)
        .where(eq(notificationSettings.organizationId, fixture.organizationId));
      checkEqual("GET does not write a settings row", rowsAfterRead.length, 0);

      // Partial write.
      const saved = await service.updateSettings(fixture.organizationId, {
        preferences: [
          { event: "invoice_due", email: false, sms: true, inApp: false },
          { event: "payment_received", email: true, sms: true, inApp: true },
        ],
      });

      checkEqual("partial save still returns all ten", saved.preferences.length, 10);
      check("save creates a settings id", saved.id.length > 0);
      check("save sets updatedAt", saved.updatedAt !== null);

      const invoiceDue = saved.preferences.find((p) => p.event === "invoice_due")!;
      checkEqual("saved event persists email=false", invoiceDue.email, false);
      checkEqual("saved event persists sms=true", invoiceDue.sms, true);
      checkEqual("saved event persists inApp=false", invoiceDue.inApp, false);

      const untouched = saved.preferences.find(
        (p) => p.event === "new_lead_submitted",
      )!;
      checkEqual(
        "omitted event falls back to defaults rather than being deleted",
        untouched.email,
        DEFAULT_CHANNEL_PREFERENCES.email,
      );

      const persisted = await systemDb
        .select()
        .from(notificationPreferences)
        .where(
          eq(notificationPreferences.organizationId, fixture.organizationId),
        );
      checkEqual("only the supplied events are persisted", persisted.length, 2);

      // Re-saving must update in place, not duplicate — this is what the
      // (organization_id, event) unique index buys.
      await service.updateSettings(fixture.organizationId, {
        preferences: [
          { event: "invoice_due", email: true, sms: false, inApp: true },
        ],
      });
      const afterResave = await systemDb
        .select()
        .from(notificationPreferences)
        .where(
          eq(notificationPreferences.organizationId, fixture.organizationId),
        );
      checkEqual("re-saving updates in place", afterResave.length, 2);

      const reread = await service.getSettings(fixture.organizationId);
      const rereadInvoice = reread.preferences.find(
        (p) => p.event === "invoice_due",
      )!;
      checkEqual("re-save took effect", rereadInvoice.email, true);
      checkEqual("re-save took effect on sms", rereadInvoice.sms, false);

      // The label is the server's, always.
      const spoofed = await service.updateSettings(fixture.organizationId, {
        preferences: [
          {
            event: "invoice_due",
            label: "<script>alert(1)</script>",
            email: true,
            sms: false,
            inApp: true,
          },
        ],
      });
      checkEqual(
        "client-supplied label is ignored",
        spoofed.preferences.find((p) => p.event === "invoice_due")!.label,
        FIRM_PREFERENCE_LABELS.invoice_due,
      );

      // ── SMS master switch ──────────────────────────────────────────────
      //
      // The switch lives on consultation_settings, whose own upsert is a FULL
      // REPLACE. Toggling SMS through that endpoint either failed validation or
      // nulled out the firm's fee configuration as a side effect, which is why
      // it has its own write path. These assertions exist to stop anyone
      // routing it back through the fee form.

      checkEqual(
        "a firm with no consultation settings reads SMS as off",
        (await service.getSettings(fixture.organizationId)).smsEnabled,
        false,
      );

      // Seed a fully-configured fee setup, exactly what a real firm has.
      await systemDb.insert(consultationSettings).values({
        organizationId: fixture.organizationId,
        chargesFee: true,
        defaultAmount: "150.00",
        feeStructure: "flat",
        timezone: "America/New_York",
      });

      await service.setSmsEnabled(fixture.organizationId, true);

      checkEqual(
        "enabling SMS is reflected in the settings payload",
        (await service.getSettings(fixture.organizationId)).smsEnabled,
        true,
      );

      const [afterEnable] = await systemDb
        .select()
        .from(consultationSettings)
        .where(
          eq(consultationSettings.organizationId, fixture.organizationId),
        );

      // THE regression this endpoint exists to prevent.
      checkEqual("the fee flag survives the toggle", afterEnable.chargesFee, true);
      checkEqual(
        "the default amount survives the toggle",
        afterEnable.defaultAmount,
        "150.00",
      );
      checkEqual(
        "the fee structure survives the toggle",
        afterEnable.feeStructure,
        "flat",
      );
      checkEqual(
        "the timezone survives the toggle",
        afterEnable.timezone,
        "America/New_York",
      );

      await service.setSmsEnabled(fixture.organizationId, false);
      const [afterDisable] = await systemDb
        .select()
        .from(consultationSettings)
        .where(
          eq(consultationSettings.organizationId, fixture.organizationId),
        );
      checkEqual("disabling SMS works", afterDisable.smsEnabled, false);
      checkEqual(
        "and still leaves the fee configuration alone",
        afterDisable.defaultAmount,
        "150.00",
      );

      await systemDb
        .delete(consultationSettings)
        .where(
          eq(consultationSettings.organizationId, fixture.organizationId),
        );
    });
  });

  // ─── Gating ────────────────────────────────────────────────────────────────
  //
  // Each of these asserts a PERSISTED row with a reason, not silence. That is
  // the whole point of the ledger: a firm asking "why didn't they get the text"
  // gets an answer.

  section("gating");

  await withTempFixture({}, async (fixture) => {
    const orgId = fixture.organizationId;

    // A lead with a good phone, full consent, and the firm's SMS switch on —
    // the only combination that should reach a provider.
    await systemDb
      .update(leads)
      .set({
        phone: "+14155552671",
        smsConsent: true,
        smsConsentAt: new Date(),
        smsConsentSource: "intake_form",
      })
      .where(eq(leads.id, fixture.leadId));

    const rowsFor = async (event: string) =>
      systemDb
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.organizationId, orgId),
            eq(notifications.event, event),
          ),
        );

    const send = (dedupe: string) =>
      notify({
        organizationId: orgId,
        event: "questionnaire_sent",
        recipients: [{ type: "lead", id: fixture.leadId }],
        context: { link: "https://app.example.com/q/abc" },
        dedupeKey: dedupe,
      });

    /**
     * Force the provider UNCONFIGURED for this first assertion.
     *
     * The original version relied on the ambient environment having no Twilio
     * credentials, which quietly stopped being true the moment real ones were
     * added to .env — and the check then failed against correct behaviour. A
     * check that reads the developer's environment is testing the environment.
     *
     * Both directions are controlled here: unset for the provider gate, set
     * further down for the gates behind it.
     */
    const envBackup = {
      provider: env.SMS_PROVIDER,
      sid: env.TWILIO_ACCOUNT_SID,
      token: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM_NUMBER,
      messaging: env.TWILIO_MESSAGING_SERVICE_SID,
    };
    const clearTwilioEnv = () => {
      delete (env as Record<string, unknown>).SMS_PROVIDER;
      delete (env as Record<string, unknown>).TWILIO_ACCOUNT_SID;
      delete (env as Record<string, unknown>).TWILIO_AUTH_TOKEN;
      delete (env as Record<string, unknown>).TWILIO_FROM_NUMBER;
      delete (env as Record<string, unknown>).TWILIO_MESSAGING_SERVICE_SID;
    };
    const restoreTwilioEnv = () => {
      (env as Record<string, unknown>).SMS_PROVIDER = envBackup.provider;
      (env as Record<string, unknown>).TWILIO_ACCOUNT_SID = envBackup.sid;
      (env as Record<string, unknown>).TWILIO_AUTH_TOKEN = envBackup.token;
      (env as Record<string, unknown>).TWILIO_FROM_NUMBER = envBackup.from;
      (env as Record<string, unknown>).TWILIO_MESSAGING_SERVICE_SID =
        envBackup.messaging;
    };

    clearTwilioEnv();
    check("provider now reads as unconfigured", !isSmsProviderConfigured());

    // No consultation_settings row exists either, so smsEnabled defaults false.
    // Whichever gate fires, the send is recorded rather than silent.
    await send("gate-1");
    let rows = await rowsFor("questionnaire_sent");
    const smsRow = rows.find((r) => r.channel === "sms");
    check("an SMS row is written even when it cannot send", smsRow !== undefined);
    checkEqual(
      "unconfigured provider is recorded as the reason",
      smsRow?.skipReason,
      "provider_unconfigured",
    );
    checkEqual("the blocked SMS row is skipped", smsRow?.status, "skipped");

    const emailRow = rows.find((r) => r.channel === "email");
    check("the email channel still went ahead", emailRow !== undefined);
    check(
      "the email row is queued or pending, not skipped",
      emailRow?.status === "queued" || emailRow?.status === "pending",
    );
    checkEqual(
      "the email address is snapshotted on the row",
      emailRow?.recipientAddress,
      `lead-${orgId.replace("check-org-", "")}@example.test`,
    );

    // Idempotency: the same dedupe key twice writes one row per channel.
    await send("gate-1");
    rows = await rowsFor("questionnaire_sent");
    checkEqual("a repeated dedupeKey writes no second row", rows.length, 2);

    // A different key does write again — otherwise dedupe would be a global
    // mute rather than an idempotency guard.
    await send("gate-2");
    rows = await rowsFor("questionnaire_sent");
    checkEqual("a different dedupeKey writes a new row", rows.length, 4);

    /**
     * Now configure a provider, so the gates BEHIND the provider check become
     * observable.
     *
     * Fixed dummy values rather than whatever is in .env, so the assertions
     * below mean the same thing on every machine. `isSmsProviderConfigured()`
     * reads these and nothing else, and `getSmsProvider()` still returns the
     * stub — this exercises the decision logic, not delivery.
     */
    (env as Record<string, unknown>).SMS_PROVIDER = "twilio";
    (env as Record<string, unknown>).TWILIO_ACCOUNT_SID = "ACcheck";
    (env as Record<string, unknown>).TWILIO_AUTH_TOKEN = "check-token";
    (env as Record<string, unknown>).TWILIO_FROM_NUMBER = "+15005550006";
    check("provider now reads as configured", isSmsProviderConfigured());

    // Consent gating, asserted through resolveChannelDecision so the provider
    // gate above does not mask the ones behind it.
    const firmSmsOn = {
      firmName: "Check Firm",
      timezone: "UTC",
      smsEnabled: true,
      preferences: new Map(),
    };
    const consented = {
      type: "lead" as const,
      id: fixture.leadId,
      name: "Jane Doe",
      email: "jane@example.test",
      rawPhone: "+14155552671",
      smsConsent: true,
      smsOptOutAt: null,
    };

    const decide = (recipient: typeof consented, firm = firmSmsOn) =>
      resolveChannelDecision({
        def: NOTIFICATION_EVENTS.questionnaire_sent,
        channel: "sms",
        recipient,
        firm,
      });

    // The firm owns the channel choice, so never having opted in is NOT a
    // refusal — otherwise choosing SMS in a picker would silently skip every
    // send. This is the assertion that would fail if per-lead opt-in were
    // reintroduced as a gate.
    checkEqual(
      "an absent opt-in does not block a send",
      await decide({ ...consented, smsConsent: false }),
      { allowed: true },
    );
    // THE assertion: an opt-out beats a transactional event. questionnaire_sent
    // is transactional, and it still must not go out by SMS — Twilio rejects it
    // with 21610 whatever we decide here.
    checkEqual(
      "an opt-out blocks even a transactional event",
      await decide({
        ...consented,
        smsConsent: true,
        smsOptOutAt: new Date(),
      }),
      { allowed: false, skipReason: "opted_out" },
    );
    checkEqual(
      "the firm SMS master switch blocks when off",
      await decide(consented, { ...firmSmsOn, smsEnabled: false }),
      { allowed: false, skipReason: "firm_sms_disabled" },
    );
    checkEqual(
      "a missing phone is recorded as no_address",
      await decide({ ...consented, rawPhone: null }),
      { allowed: false, skipReason: "no_address" },
    );
    checkEqual(
      "a consented lead on an SMS-enabled firm is allowed",
      await decide(consented),
      { allowed: true },
    );

    // Preference-tier gating, which transactional events skip entirely.
    const staffRecipient = { ...consented, type: "staff" as const };
    checkEqual(
      "a preference-tier event obeys the firm toggle",
      await resolveChannelDecision({
        def: NOTIFICATION_EVENTS.new_lead_submitted,
        channel: "email",
        recipient: staffRecipient,
        firm: {
          ...firmSmsOn,
          preferences: new Map([
            ["new_lead_submitted", { email: false, sms: false, inApp: true }],
          ]),
        },
      }),
      { allowed: false, skipReason: "preference_off" },
    );
    checkEqual(
      "a transactional event ignores the same toggle being off",
      await resolveChannelDecision({
        def: NOTIFICATION_EVENTS.questionnaire_sent,
        channel: "email",
        recipient: consented,
        firm: {
          ...firmSmsOn,
          preferences: new Map([
            ["new_lead_submitted", { email: false, sms: false, inApp: true }],
          ]),
        },
      }),
      { allowed: true },
    );

    // Email suppression, which behaves like the SMS opt-out: it beats the tier.
    await suppressEmail(consented.email!, "bounced", "evt_check");
    checkEqual(
      "a bounced address blocks a transactional email",
      await resolveChannelDecision({
        def: NOTIFICATION_EVENTS.questionnaire_sent,
        channel: "email",
        recipient: consented,
        firm: firmSmsOn,
      }),
      { allowed: false, skipReason: "email_suppressed_bounce" },
    );
    await unsuppressEmail(consented.email!);
    checkEqual(
      "lifting the suppression restores the channel",
      await resolveChannelDecision({
        def: NOTIFICATION_EVENTS.questionnaire_sent,
        channel: "email",
        recipient: consented,
        firm: firmSmsOn,
      }),
      { allowed: true },
    );
    await systemDb
      .delete(emailSuppressions)
      .where(eq(emailSuppressions.email, consented.email!));

    // An unparseable phone is a recipient we cannot reach, recorded as such
    // rather than handed to a provider that would reject it.
    await systemDb
      .update(leads)
      .set({ phone: "555-1234" })
      .where(eq(leads.id, fixture.leadId));
    await systemDb
      .insert(consultationSettings)
      .values({ organizationId: orgId, smsEnabled: true })
      .onConflictDoNothing();

    await notify({
      organizationId: orgId,
      event: "consultation_booking_link",
      recipients: [{ type: "lead", id: fixture.leadId }],
      context: { link: "https://app.example.com/book/abc" },
    });
    const bookingRows = await rowsFor("consultation_booking_link");
    const bookingSms = bookingRows.find((r) => r.channel === "sms");
    checkEqual(
      "an unparseable phone is recorded as unparseable_phone",
      bookingSms?.skipReason,
      "unparseable_phone",
    );
    checkEqual("that row is skipped", bookingSms?.status, "skipped");
    checkEqual(
      "and carries no address, because there was none to snapshot",
      bookingSms?.recipientAddress,
      null,
    );

    /**
     * A reachable number, stored in a human format.
     *
     * Note the leading "+1". With PHONE_DEFAULT_REGION unset — the default, and
     * what runs here — a purely national "(415) 555-2671" is UNPARSEABLE and
     * skipped, as the assertion above shows for "555-1234". That is the
     * deliberate trade: guessing a country would text a stranger. Firms
     * operating in one country should set PHONE_DEFAULT_REGION, or their
     * nationally-typed numbers will never receive SMS.
     */
    await systemDb
      .update(leads)
      .set({
        phone: "+1 (415) 555-2671",
        // Explicitly NOT opted in — the firm chose the channel, and that is
        // enough. This is the end-to-end version of the decision assertion
        // above: a lead who never opted in still gets a real, queued SMS row.
        smsConsent: false,
        smsConsentAt: null,
        smsConsentSource: null,
        smsOptOutAt: null,
      })
      .where(eq(leads.id, fixture.leadId));
    await notify({
      organizationId: orgId,
      event: "questionnaire_reminder",
      recipients: [{ type: "lead", id: fixture.leadId }],
      context: { link: "https://app.example.com/q/abc" },
    });
    const reminderSms = (await rowsFor("questionnaire_reminder")).find(
      (r) => r.channel === "sms",
    );
    checkEqual(
      "a sendable SMS row stores the E.164 form, not the typed one",
      reminderSms?.recipientAddress,
      "+14155552671",
    );
    check(
      "and is queued rather than skipped",
      reminderSms?.status === "queued" || reminderSms?.status === "pending",
      reminderSms?.skipReason,
    );
    check("its body carries the firm-name prefix", Boolean(reminderSms?.body));
    checkEqual(
      "the SMS body fits one segment",
      gsmSegments(reminderSms?.body ?? ""),
      1,
    );

    restoreTwilioEnv();

    await systemDb
      .delete(consultationSettings)
      .where(eq(consultationSettings.organizationId, orgId));
  });

  // ─── Channel dispatch ──────────────────────────────────────────────────────
  //
  // Proves the worker actually delivers, and that email goes through the SAME
  // path as SMS rather than remaining a separate fire-and-forget call.

  section("dispatch");

  await withTempFixture({}, async (fixture) => {
    const orgId = fixture.organizationId;

    // Intercept the mailer rather than send. Restored in a finally below.
    const realSendEmail = emailService.sendEmail.bind(emailService);
    const sentEmails: { to: string; subject: string; html: string }[] = [];
    (emailService as { sendEmail: unknown }).sendEmail = async (opts: {
      to: string;
      subject: string;
      html: string;
    }) => {
      sentEmails.push(opts);
      return { providerMessageId: `fake_${sentEmails.length}` };
    };

    try {
      const { notifications: created } = await notify({
        organizationId: orgId,
        event: "questionnaire_sent",
        recipients: [{ type: "lead", id: fixture.leadId }],
        context: { link: "https://app.example.com/q/dispatch" },
        channels: ["email"],
      });

      checkEqual("one email notification was created", created.length, 1);

      const sent = await dispatchNotification(created[0].id);
      check("dispatch reports success", sent);
      checkEqual("the mailer was called once", sentEmails.length, 1);
      check(
        "the subject came from the template",
        sentEmails[0]?.subject.includes("intake questionnaire"),
      );
      check(
        "the body was rendered from the persisted context",
        sentEmails[0]?.html.includes("https://app.example.com/q/dispatch"),
      );

      const [row] = await systemDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, created[0].id));

      checkEqual("the row reached sent", row.status, "sent");
      check("sentAt was stamped", row.sentAt !== null);
      checkEqual(
        "the provider message id was recorded for the delivery webhook",
        row.providerMessageId,
        "fake_1",
      );
      // Only a webhook may set this. Gmail SMTP in development never calls
      // back, so an email row is final at `sent` — worth asserting so nobody
      // debugs a "stuck" row that is behaving correctly.
      checkEqual("delivered is not claimed without a callback", row.deliveredAt, null);
      checkEqual("attemptCount was incremented", row.attemptCount, 1);

      // Claim-before-send: a second dispatch of the same row must not resend.
      const again = await dispatchNotification(created[0].id);
      check("a second dispatch does not resend", !again);
      checkEqual("the mailer was still called only once", sentEmails.length, 1);
    } finally {
      (emailService as { sendEmail: unknown }).sendEmail = realSendEmail;
    }
  });

  // ─── Consultation reminders ────────────────────────────────────────────────

  section("consultation reminders");

  await withTempFixture({}, async (fixture) => {
    const orgId = fixture.organizationId;

    const makeConsultation = async (scheduledAt: Date | null, status = "scheduled") => {
      const [row] = await systemDb
        .insert(consultations)
        .values({
          organizationId: orgId,
          leadId: fixture.leadId,
          scheduledAt,
          duration: 30,
          mode: "video",
          status: status as "scheduled",
        })
        .returning();
      return row;
    };

    const remindersFor = async (consultationId: string) =>
      systemDb
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.organizationId, orgId),
            eq(notifications.consultationId, consultationId),
          ),
        );

    /**
     * Rows that will still fire.
     *
     * A `skipped` row is terminal and truthful — "we did not send this because
     * SMS is unconfigured" — so a cancel must not touch it, and it is not
     * pending either. Only pending/queued count as live.
     */
    const liveRemindersFor = async (consultationId: string) =>
      (await remindersFor(consultationId)).filter(
        (r) => r.status === "pending" || r.status === "queued",
      );

    // Comfortably in the future: both offsets apply.
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const c1 = await makeConsultation(future);
    await scheduleConsultationReminders(orgId, c1.id);

    const rows = await remindersFor(c1.id);
    const events = rows.map((r) => r.event).sort();
    check(
      "both reminders are scheduled",
      events.includes("consultation_reminder_24h") &&
        events.includes("consultation_reminder_1h"),
      events,
    );
    const r24 = rows.find((r) => r.event === "consultation_reminder_24h")!;
    checkEqual(
      "the 24h reminder is timed 24 hours before",
      r24.sendAt?.getTime(),
      future.getTime() - 24 * 60 * 60 * 1000,
    );
    check(
      "the reminder renders the time in context",
      typeof (r24.payload as { when?: string }).when === "string",
    );
    const [c1After] = await systemDb
      .select()
      .from(consultations)
      .where(eq(consultations.id, c1.id));
    check("remindersScheduledAt is stamped", c1After.remindersScheduledAt !== null);

    // Rescheduling must not leave the old times behind. This is the case that
    // a schedule-only implementation gets wrong, because BullMQ silently
    // ignores an add whose job id is still in the completed set.
    const moved = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await systemDb
      .update(consultations)
      .set({ scheduledAt: moved })
      .where(eq(consultations.id, c1.id));
    await scheduleConsultationReminders(orgId, c1.id);

    const live = await liveRemindersFor(c1.id);
    checkEqual("a reschedule leaves exactly two live reminders", live.length, 2);
    checkEqual(
      "and the originals are cancelled rather than deleted",
      (await remindersFor(c1.id)).filter((r) => r.status === "cancelled").length,
      2,
    );
    const movedR24 = live.find((r) => r.event === "consultation_reminder_24h")!;
    checkEqual(
      "the live reminder uses the new time",
      movedR24.sendAt?.getTime(),
      moved.getTime() - 24 * 60 * 60 * 1000,
    );

    // Re-running the scheduler unchanged must be an exact no-op, or every
    // finalize would churn the reminders.
    await scheduleConsultationReminders(orgId, c1.id);
    checkEqual(
      "rescheduling to the same time changes nothing",
      (await liveRemindersFor(c1.id)).length,
      2,
    );

    // Cancelling marks them cancelled, so "scheduled then called off" stays in
    // the record rather than vanishing.
    await cancelConsultationReminders(orgId, c1.id);
    checkEqual(
      "cancelling leaves nothing live",
      (await liveRemindersFor(c1.id)).length,
      0,
    );

    // Two hours away: the 1-hour reminder applies, the 24-hour one does not.
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const c2 = await makeConsultation(soon);
    await scheduleConsultationReminders(orgId, c2.id);
    const soonEvents = new Set(
      (await remindersFor(c2.id)).map((r) => r.event),
    );
    checkEqual(
      "a consultation two hours out gets only the 1-hour reminder",
      [...soonEvents].join(","),
      "consultation_reminder_1h",
    );

    // A past consultation gets none — scheduling a send in the past would fire
    // immediately, telling someone their consultation is "tomorrow".
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const c3 = await makeConsultation(past);
    await scheduleConsultationReminders(orgId, c3.id);
    checkEqual("a past consultation gets no reminders", (await remindersFor(c3.id)).length, 0);

    // Not yet booked: no agreed time to remind anyone about.
    const c4 = await makeConsultation(future, "pending_payment");
    await scheduleConsultationReminders(orgId, c4.id);
    checkEqual(
      "an unbooked consultation gets no reminders",
      (await remindersFor(c4.id)).length,
      0,
    );

    await systemDb.delete(consultations).where(eq(consultations.organizationId, orgId));
  });

  // ─── Keywords ──────────────────────────────────────────────────────────────

  section("keywords");

  checkEqual("STOP is recognised", classifyKeyword("STOP"), "STOP");
  checkEqual("lowercase stop is recognised", classifyKeyword("stop"), "STOP");
  checkEqual("trailing punctuation is tolerated", classifyKeyword(" Stop. "), "STOP");
  checkEqual("UNSUBSCRIBE is a stop word", classifyKeyword("unsubscribe"), "STOP");
  checkEqual("START is recognised", classifyKeyword("START"), "START");
  checkEqual("HELP is recognised", classifyKeyword("help"), "HELP");
  // The important negative: a sentence containing "stop" is a complaint to act
  // on, not an opt-out to apply silently. Treating it as one would drop a
  // client's SMS without them ever asking.
  checkEqual(
    "a sentence containing stop is not an opt-out",
    classifyKeyword("please stop sending me so many forms"),
    null,
  );
  checkEqual("unrelated text matches nothing", classifyKeyword("thanks!"), null);

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  // ─── SMS provider selection ────────────────────────────────────────────────

  section("sms provider selection");

  await withSmsEnv({}, async () => {
    checkEqual("unset SMS_PROVIDER falls back to the stub", getSmsProvider().name, "stub");
  });
  await withSmsEnv({ SMS_PROVIDER: "nonsense" }, async () => {
    checkEqual("an unrecognised provider falls back to the stub", getSmsProvider().name, "stub");
  });
  await withSmsEnv(
    { SMS_PROVIDER: "twilio", ...TWILIO_ENV },
    async () => checkEqual("SMS_PROVIDER=twilio selects Twilio", getSmsProvider().name, "twilio"),
  );
  await withSmsEnv(
    { SMS_PROVIDER: "TWILIO", ...TWILIO_ENV },
    async () =>
      checkEqual("provider matching is case-insensitive", getSmsProvider().name, "twilio"),
  );
  await withSmsEnv({ SMS_PROVIDER: "telnyx", ...telnyxEnv() }, async () =>
    checkEqual("SMS_PROVIDER=telnyx selects Telnyx", getSmsProvider().name, "telnyx"),
  );
  // The public key is the one credential that can be forgotten while sending
  // still works, so its absence must stop the provider resolving at all.
  await withSmsEnv(
    { SMS_PROVIDER: "telnyx", ...telnyxEnv(), TELNYX_PUBLIC_KEY: "" },
    async () => {
      checkEqual(
        "Telnyx without a public key falls back to the stub",
        getSmsProvider().name,
        "stub",
      );
      checkEqual(
        "and reports itself unconfigured",
        isSmsProviderConfigured("telnyx"),
        false,
      );
    },
  );
  // THE rollback assertion: a webhook route bound to Twilio keeps working
  // while Telnyx is the active sender. If this ever fails, switching provider
  // silently discards the other vendor's in-flight callbacks.
  await withSmsEnv(
    { SMS_PROVIDER: "telnyx", ...telnyxEnv(), ...TWILIO_ENV },
    async () => {
      checkEqual("Telnyx is the active sender", getSmsProvider().name, "telnyx");
      checkEqual(
        "but Twilio still resolves by name for its own webhook",
        getSmsProviderByName("twilio")?.name,
        "twilio",
      );
    },
  );

  // ─── Provider webhooks ─────────────────────────────────────────────────────
  //
  // Every DB assertion below is written once and executed against BOTH
  // providers. The signing is hand-rolled per provider, deliberately: using the
  // same helper to sign and to verify would pass even if both were wrong.

  section("webhooks");

  await runSmsWebhookSuite(twilioFixture());
  await runSmsWebhookSuite(telnyxFixture());


  section("resend webhooks");

  await withTempFixture({}, async (fixture) => {
    const orgId = fixture.organizationId;
    const secret = "whsec_" + Buffer.from("check-secret-key-here").toString("base64");
    const savedSecret = env.RESEND_WEBHOOK_SECRET;
    (env as Record<string, unknown>).RESEND_WEBHOOK_SECRET = secret;

    try {
      const [row] = await systemDb
        .insert(notifications)
        .values({
          organizationId: orgId,
          event: "questionnaire_sent",
          tier: "transactional",
          channel: "email",
          status: "sent",
          recipientType: "lead",
          recipientId: fixture.leadId,
          recipientAddress: "bouncy@example.test",
          providerMessageId: "resend-email-1",
          sentAt: new Date(),
        })
        .returning();

      const send = async (payload: unknown) => {
        const body = JSON.stringify(payload);
        const msgId = `msg_${Math.random().toString(36).slice(2)}`;
        const wh = new Webhook(secret);
        const headers = wh.sign(msgId, new Date(), body) as unknown as string;
        return handleResendWebhook(Buffer.from(body), {
          "svix-id": msgId,
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": headers,
        });
      };

      await send({
        type: "email.delivered",
        data: { email_id: "resend-email-1", to: ["bouncy@example.test"] },
      });
      let [after] = await systemDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, row.id));
      checkEqual("email.delivered marks delivered", after.status, "delivered");
      check("and stamps deliveredAt", after.deliveredAt !== null);

      await send({
        type: "email.sent",
        data: { email_id: "resend-email-1", to: ["bouncy@example.test"] },
      });
      [after] = await systemDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, row.id));
      checkEqual(
        "a late email.sent does not regress a delivery",
        after.status,
        "delivered",
      );

      // A tampered body must not verify.
      let rejected = false;
      await handleResendWebhook(Buffer.from('{"type":"email.delivered"}'), {
        "svix-id": "msg_x",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,bogus",
      }).catch(() => {
        rejected = true;
      });
      check("an invalid Svix signature is rejected", rejected);

      // A bounce suppresses the address platform-wide.
      const [bounceRow] = await systemDb
        .insert(notifications)
        .values({
          organizationId: orgId,
          event: "questionnaire_reminder",
          tier: "transactional",
          channel: "email",
          status: "sent",
          recipientType: "lead",
          recipientId: fixture.leadId,
          recipientAddress: "bouncy@example.test",
          providerMessageId: "resend-email-2",
          sentAt: new Date(),
        })
        .returning();

      await send({
        type: "email.bounced",
        data: {
          email_id: "resend-email-2",
          to: ["bouncy@example.test"],
          bounce: { type: "Permanent", subType: "General", message: "mailbox does not exist" },
        },
      });

      const [bounced] = await systemDb
        .select()
        .from(notifications)
        .where(eq(notifications.id, bounceRow.id));
      checkEqual("a bounce marks the row failed", bounced.status, "failed");
      check(
        "and records the provider's reason",
        (bounced.failureReason ?? "").includes("mailbox"),
      );
      checkEqual(
        "the address is now suppressed",
        await getEmailSuppression("bouncy@example.test"),
        "bounced",
      );
      // Case-insensitive, because addresses arrive however the sender typed them.
      checkEqual(
        "suppression lookup is case-insensitive",
        await getEmailSuppression("Bouncy@Example.TEST"),
        "bounced",
      );

      await send({
        type: "suppression.removed",
        data: { email_id: "resend-email-2", to: ["bouncy@example.test"] },
      });
      checkEqual(
        "suppression.removed lifts it",
        await getEmailSuppression("bouncy@example.test"),
        null,
      );

      // A complaint is the more serious signal and replaces a bounce.
      await send({
        type: "email.complained",
        data: { email_id: "resend-email-2", to: ["bouncy@example.test"] },
      });
      checkEqual(
        "a complaint suppresses with its own reason",
        await getEmailSuppression("bouncy@example.test"),
        "complained",
      );

      // Open and click tracking are deliberately ignored.
      const ignored = await send({
        type: "email.opened",
        data: { email_id: "resend-email-1", to: ["bouncy@example.test"] },
      });
      checkEqual("email.opened is ignored", ignored.handled, false);

      await systemDb
        .delete(emailSuppressions)
        .where(eq(emailSuppressions.email, "bouncy@example.test"));
    } finally {
      (env as Record<string, unknown>).RESEND_WEBHOOK_SECRET = savedSecret;
    }
  });

  // ─── Validation ────────────────────────────────────────────────────────────

  section("preferences validation");

  check(
    "a known event validates",
    updateNotificationSettingsSchema.safeParse({
      preferences: [{ event: "invoice_due", email: true, sms: false, inApp: true }],
    }).success,
  );
  check(
    "an unknown event is rejected",
    !updateNotificationSettingsSchema.safeParse({
      preferences: [{ event: "not_an_event", email: true, sms: false, inApp: true }],
    }).success,
  );
  check(
    "an empty preference list is rejected",
    !updateNotificationSettingsSchema.safeParse({ preferences: [] }).success,
  );
  check(
    "a missing channel flag is rejected",
    !updateNotificationSettingsSchema.safeParse({
      preferences: [{ event: "invoice_due", email: true, sms: false }],
    }).success,
  );

  await report();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
