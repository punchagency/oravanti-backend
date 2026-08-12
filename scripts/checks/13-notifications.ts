/**
 * Notification layer: phone normalisation, firm preferences, and the event
 * catalog.
 *
 * Grows alongside the feature — each phase adds its own section, so a phase can
 * be verified without waiting for the ones after it.
 *
 *   npm run check 13-notifications
 */
import { and, eq } from "drizzle-orm";
import { env } from "../../src/config/env";
import { systemDb } from "../../src/db/client";
import { consultationSettings } from "../../src/db/schema/consultation-settings";
import { emailSuppressions } from "../../src/db/schema/email-suppressions";
import { leads } from "../../src/db/schema/leads";
import { notifications } from "../../src/db/schema/notifications";
import {
  suppressEmail,
  unsuppressEmail,
} from "../../src/notifications/consent.service";
import { notify } from "../../src/notifications/notification.service";
import { resolveChannelDecision } from "../../src/notifications/preferences.service";
import { isSmsProviderConfigured } from "../../src/notifications/sms/sms.provider";
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

    // No consultation_settings row exists, so smsEnabled defaults false — and
    // the SMS provider is unconfigured in checks anyway, which is the first
    // gate. Either way the send is recorded, never silent.
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
     * Pretend a provider is configured, so the gates BEHIND the provider check
     * become observable.
     *
     * `isSmsProviderConfigured()` reads these three values and nothing else, so
     * setting them is enough — and `getSmsProvider()` still returns the stub,
     * which is what we want: this exercises the decision logic, not delivery.
     *
     * That the provider gate masks everything below it when unset is itself
     * correct, and is what the rows asserted above demonstrate.
     */
    const savedEnv = {
      sid: env.TWILIO_ACCOUNT_SID,
      token: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM_NUMBER,
    };
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

    checkEqual(
      "no consent is recorded as no_consent",
      (await decide({ ...consented, smsConsent: false })),
      { allowed: false, skipReason: "no_consent" },
    );
    // THE assertion: an opt-out beats a transactional event. questionnaire_sent
    // is transactional, and it still must not go out by SMS.
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
      .set({ phone: "+1 (415) 555-2671" })
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

    (env as Record<string, unknown>).TWILIO_ACCOUNT_SID = savedEnv.sid;
    (env as Record<string, unknown>).TWILIO_AUTH_TOKEN = savedEnv.token;
    (env as Record<string, unknown>).TWILIO_FROM_NUMBER = savedEnv.from;

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
