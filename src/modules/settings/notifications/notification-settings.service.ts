import { eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { consultationSettings } from "../../../db/schema/consultation-settings";
import {
  notificationPreferences,
  notificationSettings,
  type NotificationPreference as NotificationPreferenceRow,
  type NotificationSettings as NotificationSettingsRow,
} from "../../../db/schema/notification-settings";
import {
  DEFAULT_CHANNEL_PREFERENCES,
  FIRM_PREFERENCE_EVENTS,
  FIRM_PREFERENCE_LABELS,
  type FirmPreferenceEventKey,
} from "../../../notifications/events";
import type { UpdateNotificationSettingsBody } from "./notification-settings.validation";

/**
 * The shape oravanti/src/api/firm-settings.ts expects. Matching it exactly is
 * the point of this module — the settings screen has been shipped and calling
 * this endpoint since before it existed, silently falling back to its own
 * defaults because the route 404'd.
 */
export type FirmNotificationSettingsDTO = {
  id: string;
  organizationId: string;
  preferences: {
    event: FirmPreferenceEventKey;
    label: string;
    email: boolean;
    sms: boolean;
    inApp: boolean;
  }[];
  /**
   * The firm-wide SMS master switch.
   *
   * Physically stored on `consultation_settings.sms_enabled` for historical
   * reasons, but it belongs to notifications — every SMS send is gated on it,
   * not just consultation ones. Surfaced here so the notifications screen reads
   * and writes one endpoint instead of submitting the consultation FEE form to
   * change a messaging setting.
   */
  smsEnabled: boolean;
  updatedAt: Date | null;
};

/**
 * Always returns all ten events in catalog order, whether or not a row exists
 * for each.
 *
 * The screen renders whatever it is given, so a partially-populated response
 * would render a partial matrix. Filling the gaps here rather than in the
 * client keeps the catalog the single source of what exists.
 */
const buildPreferences = (rows: NotificationPreferenceRow[]) => {
  const byEvent = new Map(rows.map((row) => [row.event, row]));

  return FIRM_PREFERENCE_EVENTS.map((event) => {
    const row = byEvent.get(event);
    return {
      event,
      // Server-owned, never the value the client sent.
      label: FIRM_PREFERENCE_LABELS[event],
      email: row?.emailEnabled ?? DEFAULT_CHANNEL_PREFERENCES.email,
      sms: row?.smsEnabled ?? DEFAULT_CHANNEL_PREFERENCES.sms,
      inApp: row?.inAppEnabled ?? DEFAULT_CHANNEL_PREFERENCES.inApp,
    };
  });
};

export class NotificationSettingsService {
  /**
   * Read, defaulting without writing.
   *
   * A firm that has never opened the settings page gets the defaults and no
   * rows are created. Persisting on read would turn a GET into a write, and
   * would make "has this firm ever configured notifications?" unanswerable.
   * Mirrors ConsultationSettingsService.getSettings.
   */
  getSettings = async (
    organizationId: string,
  ): Promise<FirmNotificationSettingsDTO> => {
    const [settings] = await db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.organizationId, organizationId))
      .limit(1);

    const smsEnabled = await this.readSmsEnabled(organizationId);

    if (!settings) {
      return {
        // The screen only uses `id` as a React key and to detect "saved yet?".
        // An empty string says "no settings row" without inventing a uuid that
        // matches nothing in the database.
        id: "",
        organizationId,
        preferences: buildPreferences([]),
        smsEnabled,
        updatedAt: null,
      };
    }

    const rows = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.organizationId, organizationId));

    return this.toDTO(settings, rows, smsEnabled);
  };

  /**
   * Flip the firm-wide SMS master switch, and nothing else.
   *
   * Deliberately NOT routed through the consultation settings upsert, which is
   * a full replace: sending it a partial body recomputes every fee field from
   * what was omitted, so toggling SMS through it would either fail validation
   * or quietly null out the firm's default amount, fee structure and waiver
   * window. A messaging switch has no business submitting the fee form.
   */
  setSmsEnabled = async (
    organizationId: string,
    enabled: boolean,
  ): Promise<{ smsEnabled: boolean }> => {
    await db
      .insert(consultationSettings)
      .values({ organizationId, smsEnabled: enabled })
      .onConflictDoUpdate({
        target: consultationSettings.organizationId,
        // Only this column. Everything else on the row is left exactly as it
        // was, which is the whole point.
        set: { smsEnabled: enabled, updatedAt: new Date() },
      });

    return { smsEnabled: enabled };
  };

  private readSmsEnabled = async (organizationId: string): Promise<boolean> => {
    const [row] = await db
      .select({ smsEnabled: consultationSettings.smsEnabled })
      .from(consultationSettings)
      .where(eq(consultationSettings.organizationId, organizationId))
      .limit(1);

    return row?.smsEnabled ?? false;
  };

  /**
   * Upsert the parent row, then each supplied event.
   *
   * Events the client omits are left alone rather than deleted: the screen
   * always sends all ten, but a future partial save must not silently reset
   * every toggle it did not mention.
   */
  updateSettings = async (
    organizationId: string,
    body: UpdateNotificationSettingsBody,
  ): Promise<FirmNotificationSettingsDTO> => {
    const now = new Date();

    const [settings] = await db
      .insert(notificationSettings)
      .values({ organizationId })
      .onConflictDoUpdate({
        target: notificationSettings.organizationId,
        set: { updatedAt: now },
      })
      .returning();

    for (const preference of body.preferences) {
      await db
        .insert(notificationPreferences)
        .values({
          settingsId: settings.id,
          organizationId,
          event: preference.event,
          emailEnabled: preference.email,
          smsEnabled: preference.sms,
          inAppEnabled: preference.inApp,
        })
        .onConflictDoUpdate({
          target: [
            notificationPreferences.organizationId,
            notificationPreferences.event,
          ],
          set: {
            emailEnabled: preference.email,
            smsEnabled: preference.sms,
            inAppEnabled: preference.inApp,
            updatedAt: now,
          },
        });
    }

    const rows = await db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.organizationId, organizationId));

    return this.toDTO(
      settings,
      rows,
      await this.readSmsEnabled(organizationId),
    );
  };

  private toDTO = (
    settings: NotificationSettingsRow,
    rows: NotificationPreferenceRow[],
    smsEnabled: boolean,
  ): FirmNotificationSettingsDTO => ({
    id: settings.id,
    organizationId: settings.organizationId,
    preferences: buildPreferences(rows),
    smsEnabled,
    updatedAt: settings.updatedAt,
  });
}
