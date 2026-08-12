import { eq } from "drizzle-orm";
import { systemDb } from "../db/client";
import { consultationSettings } from "../db/schema/consultation-settings";
import { notificationPreferences } from "../db/schema/notification-settings";
import { getEmailSuppression, hasSmsConsent } from "./consent.service";
import {
  DEFAULT_CHANNEL_PREFERENCES,
  type FirmPreferenceEventKey,
  type NotificationEventDef,
} from "./events";
import { isSmsProviderConfigured } from "./sms/sms.provider";
import type {
  ChannelDecision,
  NotificationChannel,
  ResolvedRecipient,
} from "./types";

/**
 * Whether a given channel may be used for a given recipient.
 *
 * The order below is the whole policy, and it is ordered by who gets to decide:
 * the provider (can we send at all), then the RECIPIENT (did they refuse), then
 * the FIRM (do they want this), then reality (is there an address).
 *
 * The consequential part is that the recipient outranks the firm AND outranks
 * the transactional tier. A contact who texted STOP does not receive their
 * payment link by SMS. That is not a preference being respected, it is a
 * refusal being obeyed, and a transactional exception here is precisely the
 * exception that produces a TCPA complaint.
 */

export type ChannelPreferences = Record<
  FirmPreferenceEventKey,
  { email: boolean; sms: boolean; inApp: boolean }
>;

/**
 * Firm-wide SMS master switch, read from consultation_settings.sms_enabled.
 *
 * That column has existed, defaulted false, and been read by nothing since it
 * was added. Making it the gate here is what finally gives it a job — and
 * because it defaults false, merging this entire feature changes nothing for
 * any existing firm until an admin turns it on.
 */
export const isFirmSmsEnabled = async (
  organizationId: string,
): Promise<boolean> => {
  const [row] = await systemDb
    .select({ smsEnabled: consultationSettings.smsEnabled })
    .from(consultationSettings)
    .where(eq(consultationSettings.organizationId, organizationId))
    .limit(1);

  return row?.smsEnabled ?? false;
};

/**
 * Firm preferences, defaulted per event.
 *
 * A firm with no rows gets defaults for everything rather than nothing — the
 * absence of a row means "never configured", not "everything off".
 */
export const getFirmPreferences = async (
  organizationId: string,
): Promise<Map<string, { email: boolean; sms: boolean; inApp: boolean }>> => {
  const rows = await systemDb
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.organizationId, organizationId));

  return new Map(
    rows.map((row) => [
      row.event,
      {
        email: row.emailEnabled,
        sms: row.smsEnabled,
        inApp: row.inAppEnabled,
      },
    ]),
  );
};

/**
 * Everything needed to decide, gathered once per notify() call rather than once
 * per recipient — a firm-wide alert to twelve staff should read the firm's
 * settings once.
 */
export type FirmContext = {
  firmName: string;
  timezone: string;
  smsEnabled: boolean;
  preferences: Map<string, { email: boolean; sms: boolean; inApp: boolean }>;
};

export const resolveChannelDecision = async (opts: {
  def: NotificationEventDef;
  channel: NotificationChannel;
  recipient: ResolvedRecipient;
  firm: FirmContext;
}): Promise<ChannelDecision> => {
  const { def, channel, recipient, firm } = opts;

  // 1. Can we send on this channel at all?
  if (channel === "sms" && !isSmsProviderConfigured()) {
    return { allowed: false, skipReason: "provider_unconfigured" };
  }

  // 2. Did the recipient refuse? Beats everything below, including the
  //    transactional tier.
  if (channel === "sms" && !hasSmsConsent(recipient)) {
    return {
      allowed: false,
      skipReason: recipient.smsOptOutAt ? "opted_out" : "no_consent",
    };
  }

  if (channel === "email" && recipient.email) {
    const suppression = await getEmailSuppression(recipient.email);
    if (suppression) {
      return {
        allowed: false,
        skipReason:
          suppression === "bounced"
            ? "email_suppressed_bounce"
            : suppression === "complained"
              ? "email_suppressed_complaint"
              : "email_suppressed_provider",
      };
    }
  }

  // 3. Firm-wide SMS master switch. Applies to both tiers — a firm that has not
  //    turned SMS on has not agreed to be billed for it.
  if (channel === "sms" && !firm.smsEnabled) {
    return { allowed: false, skipReason: "firm_sms_disabled" };
  }

  // 4. Firm preferences, for preference-tier events only. Transactional events
  //    skip this: a firm switching "email off" must not silently break its own
  //    intake by suppressing the questionnaire link its client is waiting for.
  if (def.tier === "preference" && def.prefKey) {
    const pref = firm.preferences.get(def.prefKey) ?? DEFAULT_CHANNEL_PREFERENCES;
    const enabled =
      channel === "email"
        ? pref.email
        : channel === "sms"
          ? pref.sms
          : pref.inApp;

    if (!enabled) return { allowed: false, skipReason: "preference_off" };
  }

  // 5. Is there anywhere to send it? In-app needs no address — the row is the
  //    delivery.
  if (channel === "email" && !recipient.email) {
    return { allowed: false, skipReason: "no_address" };
  }
  if (channel === "sms" && !recipient.rawPhone) {
    return { allowed: false, skipReason: "no_address" };
  }

  return { allowed: true };
};

/**
 * Reserved hook for quiet hours.
 *
 * Deliberately the identity function. The pieces are in place — `sendAt` is a
 * real column, the worker honours a delay, and the firm timezone is already
 * resolved into FirmContext — but the policy is not decided: TCPA's 8am-9pm
 * window governs marketing rather than transactional messages, and deferring a
 * 1-hour consultation reminder past the consultation would be worse than
 * sending it early. Naming the gap beats half-implementing it.
 */
export const deferForQuietHours = (sendAt: Date, _timezone: string): Date =>
  sendAt;
