import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";

export const consultationFeeStructureEnum = pgEnum(
  "consultation_fee_structure",
  ["flat", "custom_per_case_type", "waived_if_retainer"],
);

export const consultationSettings = pgTable("consultation_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id),
  chargesFee: boolean("charges_fee").notNull().default(false),
  defaultAmount: numeric("default_amount", { precision: 10, scale: 2 }),
  feeStructure: consultationFeeStructureEnum("fee_structure"),
  waiverWindowDays: integer("waiver_window_days"),
  // IANA timezone the firm operates in (e.g. "America/New_York"). Business logic
  // (office hours, scheduling, deadlines, reporting) is computed in this zone.
  timezone: text("timezone").notNull().default("UTC"),
  // BCP-47 language tag ("en", "fr") the firm reads its own dashboards in.
  //
  // Firm-level, NOT lead-level: `leads.language` governs what the *client*
  // receives, whereas this governs staff-facing prose — a French-speaking
  // lead's AI review findings still render in English for a US firm.
  //
  // BCP-47 deliberately, rather than a fourth spelling of "english": the
  // codebase already carries `leads.language` (free text "english"),
  // `client_contacts.languagePreference` (enum "en") and
  // `questionnaires.language` (text "english").
  language: text("language").notNull().default("en"),
  // The firm-wide SMS master switch, read by resolveChannelDecision on every
  // SMS send. Off means no text message leaves the system for this firm, on any
  // channel-picker or event, transactional or not.
  //
  // Defaults false and stays false until an admin turns it on: SMS costs money
  // per message and reaches a phone rather than an inbox, so it is an opt-in.
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ConsultationSettings = typeof consultationSettings.$inferSelect;
export type NewConsultationSettings = typeof consultationSettings.$inferInsert;
