import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

/**
 * Per-firm notification settings.
 *
 * Split into a parent row and per-event children rather than one jsonb blob:
 * the frontend contract expects a settings `id` and `updatedAt` alongside the
 * preference list, and per-event rows can be read with a single indexed lookup
 * when resolving whether to send.
 *
 * Quiet hours are declared here but unused. The columns exist because the
 * scheduling path already carries a `sendAt` and a firm timezone
 * (consultation_settings.timezone), so honouring them later is a change in one
 * function rather than a migration. Nothing reads them today, and nothing
 * pretends to.
 */
export const notificationSettings = pgTable("notification_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id),

  /** Reserved. Local time "HH:mm" within the firm timezone. Not yet enforced. */
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * One row per firm per notification event, holding the three channel toggles.
 *
 * `event` is `text` rather than a pgEnum on purpose. These ten keys are a UI
 * vocabulary that will churn as features land, and freezing them into a
 * Postgres enum makes adding an eleventh a migration. Validity is enforced by
 * Zod against the catalog in src/notifications/events.ts, which is also what
 * supplies the display label — the label is never persisted, so a client cannot
 * write display strings into a settings table.
 *
 * `organizationId` is denormalised from the parent so the RLS policy and every
 * lookup are single-column predicates.
 *
 * Absence of a row is meaningful: it means "defaults", and the read path
 * returns those without writing. A firm that has never opened the settings page
 * has no rows here, and that is the correct state rather than something to
 * backfill.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    settingsId: uuid("settings_id")
      .notNull()
      .references(() => notificationSettings.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),

    event: text("event").notNull(),

    /**
     * Defaults match the frontend's buildDefaultPreferences(): email and in-app
     * on, SMS off. SMS starts off because it costs money per message and
     * reaches a phone rather than an inbox — an opt-in, not an opt-out.
     */
    emailEnabled: boolean("email_enabled").notNull().default(true),
    smsEnabled: boolean("sms_enabled").notNull().default(false),
    inAppEnabled: boolean("in_app_enabled").notNull().default(true),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notification_preferences_org_event_uidx").on(
      table.organizationId,
      table.event,
    ),
  ],
);

export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type NewNotificationSettings = typeof notificationSettings.$inferInsert;
export type NotificationPreference =
  typeof notificationPreferences.$inferSelect;
export type NewNotificationPreference =
  typeof notificationPreferences.$inferInsert;
