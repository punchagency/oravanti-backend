import { eq } from "drizzle-orm";
import { systemDb } from "../db/client";
import { consultationLocations } from "../db/schema/consultation-locations";
import { consultationSettings } from "../db/schema/consultation-settings";
import { consultations } from "../db/schema/consultations";
import { leads } from "../db/schema/leads";
import { staff } from "../db/schema/staff";
import { formatWithZone } from "../utils/date";
import { cancelNotifications, notify } from "./notification.service";

/**
 * Consultation reminders.
 *
 * Nothing reminded anyone about a consultation before this: `consultations` had
 * no reminder columns and the only scheduled job in the system was the
 * questionnaire chase. A lead booked a time and then heard nothing until it
 * arrived.
 *
 * The reminders are ordinary `notifications` rows with a `sendAt` and a
 * deterministic dedupe key. That is what makes rescheduling safe — the key
 * identifies "the 24-hour reminder for this consultation", so the cancel-and-
 * re-add below cannot leave two.
 */

export const REMINDER_OFFSETS = [
  { event: "consultation_reminder_24h", key: "24h", ms: 24 * 60 * 60 * 1000 },
  { event: "consultation_reminder_1h", key: "1h", ms: 60 * 60 * 1000 },
] as const;

const dedupePrefix = (consultationId: string) =>
  `consultation-reminder-${consultationId}`;

/**
 * Identifies "the 24-hour reminder for this consultation" — a stable identity
 * that survives rescheduling.
 *
 * This works because `cancelNotifications` releases the key when it cancels a
 * row: the cancel-then-add below would otherwise collide with the row it just
 * cancelled and be silently dropped, leaving a consultation with no reminders
 * and nothing to indicate why.
 */
const dedupeKey = (consultationId: string, offsetKey: string) =>
  `${dedupePrefix(consultationId)}-${offsetKey}`;

/**
 * Schedule (or reschedule) both reminders for a consultation.
 *
 * ALWAYS cancels first, even on a first call. BullMQ silently ignores an `add`
 * whose job id still exists in the completed set, so a reschedule that only
 * added would produce a reminder that never fires — and "no reminder arrived"
 * is indistinguishable from "nothing was scheduled", which is the hardest class
 * of bug to notice. Remove-then-add makes the operation idempotent in fact
 * rather than in intention.
 *
 * Safe to call on any consultation. Anything not actually scheduled in the
 * future ends up with its reminders cancelled and none created.
 */
export const scheduleConsultationReminders = async (
  organizationId: string,
  consultationId: string,
): Promise<void> => {
  await cancelConsultationReminders(organizationId, consultationId);

  const [consultation] = await systemDb
    .select()
    .from(consultations)
    .where(eq(consultations.id, consultationId))
    .limit(1);

  if (!consultation) return;
  // Only a consultation that is actually booked for a future moment can be
  // reminded about. pending_payment and awaiting_slot_selection have no agreed
  // time yet; completed and cancelled have no future.
  if (consultation.status !== "scheduled") return;
  if (!consultation.scheduledAt) return;

  const scheduledAt = consultation.scheduledAt.getTime();
  if (scheduledAt <= Date.now()) return;

  const [lead] = await systemDb
    .select()
    .from(leads)
    .where(eq(leads.id, consultation.leadId))
    .limit(1);

  if (!lead) return;

  const context = await buildContext(organizationId, consultation, lead.timezone);

  for (const offset of REMINDER_OFFSETS) {
    const sendAt = new Date(scheduledAt - offset.ms);

    // A consultation booked for two hours' time gets the 1-hour reminder and
    // not the 24-hour one. Scheduling a send in the past would fire it
    // immediately, telling someone their consultation is "tomorrow" when it is
    // this afternoon.
    if (sendAt.getTime() <= Date.now()) continue;

    await notify({
      organizationId,
      event: offset.event,
      recipients: [{ type: "lead", id: consultation.leadId }],
      context,
      sendAt,
      scenario: { leadId: consultation.leadId, consultationId },
      dedupeKey: dedupeKey(consultationId, offset.key),
    });
  }

  await systemDb
    .update(consultations)
    .set({ remindersScheduledAt: new Date(), updatedAt: new Date() })
    .where(eq(consultations.id, consultationId));
};

/**
 * Cancel any pending reminders for a consultation.
 *
 * Called on reschedule (before re-adding), on cancellation, and when a
 * consultation completes early — a reminder for something that already happened
 * is worse than no reminder.
 */
export const cancelConsultationReminders = async (
  organizationId: string,
  consultationId: string,
): Promise<number> =>
  cancelNotifications(organizationId, dedupePrefix(consultationId));

/**
 * The reminder's rendered detail.
 *
 * `when` is formatted HERE, at scheduling time, in the LEAD's timezone —
 * deliberately, rather than storing a Date for the template to format later.
 * The context is persisted as jsonb and rendered by a worker hours or days
 * afterwards, which has no idea whose timezone to use; a reminder naming the
 * wrong hour is worse than none at all.
 */
const buildContext = async (
  organizationId: string,
  consultation: typeof consultations.$inferSelect,
  leadTimezone: string | null,
): Promise<Record<string, unknown>> => {
  const [settings] = await systemDb
    .select({ timezone: consultationSettings.timezone })
    .from(consultationSettings)
    .where(eq(consultationSettings.organizationId, organizationId))
    .limit(1);

  // The lead's own zone when known, else the firm's — the same fallback
  // getLeadTimezone applies elsewhere.
  const tz = leadTimezone ?? settings?.timezone ?? "UTC";

  const attorney = consultation.leadAttorneyId
    ? (
        await systemDb
          .select({ firstName: staff.firstName, lastName: staff.lastName })
          .from(staff)
          .where(eq(staff.id, consultation.leadAttorneyId))
          .limit(1)
      )[0]
    : undefined;

  const location =
    consultation.mode === "in_person" && consultation.locationId
      ? (
          await systemDb
            .select({
              name: consultationLocations.label,
              address: consultationLocations.addressLine1,
            })
            .from(consultationLocations)
            .where(eq(consultationLocations.id, consultation.locationId))
            .limit(1)
        )[0]
      : undefined;

  const modeLabel =
    consultation.mode === "video"
      ? "Video call"
      : consultation.mode === "phone_call"
        ? "Phone call"
        : "In person";

  return {
    when: formatWithZone(consultation.scheduledAt!, tz),
    modeLabel,
    ...(attorney
      ? { attorneyName: `${attorney.firstName} ${attorney.lastName}`.trim() }
      : {}),
    // Only for video: a join link on an in-person appointment is noise, and on
    // a phone call it is wrong.
    ...(consultation.mode === "video" && consultation.videoLink
      ? { joinUrl: consultation.videoLink }
      : {}),
    ...(location
      ? {
          location: [location.name, location.address]
            .filter(Boolean)
            .join(", "),
        }
      : {}),
  };
};
