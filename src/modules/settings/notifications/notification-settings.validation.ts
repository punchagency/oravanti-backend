import { z } from "zod";
import { FIRM_PREFERENCE_EVENTS } from "../../../notifications/events";

/**
 * One row of the settings screen's channel matrix.
 *
 * `label` is accepted and then ignored — the server always answers with its own
 * from FIRM_PREFERENCE_LABELS. It is declared here only because the frontend
 * round-trips the object it was given, and rejecting the field would fail every
 * legitimate save. Persisting client-supplied display strings into a settings
 * table is how a stored-XSS-shaped bug gets in.
 */
export const notificationPreferenceSchema = z.object({
  event: z.enum(FIRM_PREFERENCE_EVENTS),
  label: z.string().optional(),
  email: z.boolean(),
  sms: z.boolean(),
  inApp: z.boolean(),
});

/**
 * A partial list is legal. Events the client omits keep whatever they already
 * had, or fall back to defaults — they are never deleted. The screen always
 * sends all ten, but a partial save must not silently reset the rest.
 */
export const updateNotificationSettingsSchema = z.object({
  preferences: z.array(notificationPreferenceSchema).min(1),
});

export type NotificationPreferenceInput = z.infer<
  typeof notificationPreferenceSchema
>;
export type UpdateNotificationSettingsBody = z.infer<
  typeof updateNotificationSettingsSchema
>;
