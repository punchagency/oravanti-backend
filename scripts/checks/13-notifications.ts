/**
 * Notification layer: phone normalisation, firm preferences, and the event
 * catalog.
 *
 * Grows alongside the feature — each phase adds its own section, so a phase can
 * be verified without waiting for the ones after it.
 *
 *   npm run check 13-notifications
 */
import { eq } from "drizzle-orm";
import { systemDb } from "../../src/db/client";
import {
  notificationPreferences,
  notificationSettings,
} from "../../src/db/schema/notification-settings";
import {
  DEFAULT_CHANNEL_PREFERENCES,
  FIRM_PREFERENCE_EVENTS,
  FIRM_PREFERENCE_LABELS,
  isFirmPreferenceEvent,
} from "../../src/notifications/events";
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
