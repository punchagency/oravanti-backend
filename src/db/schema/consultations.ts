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
import { consultationLocations } from "./consultation-locations";
import { leads } from "./leads";
import { staff } from "./staff";

export const consultationModeEnum = pgEnum("consultation_mode", [
  "video",
  "in_person",
  "phone_call",
]);

export const consultationStatusEnum = pgEnum("consultation_status", [
  // Pre-scheduled states (lead-driven booking flow)
  "pending_payment",
  "awaiting_slot_selection",
  // Scheduled lifecycle
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
]);

export const consultationOutcomeEnum = pgEnum("consultation_outcome", [
  "proceed",
  "close_no_case",
  "refer_elsewhere",
  "follow_up",
]);

export const consultationFeeStatusEnum = pgEnum("consultation_fee_status", [
  "none",
  "unpaid",
  "paid",
  "waived",
]);

export const consultationBookingStatusEnum = pgEnum(
  "consultation_booking_status",
  ["sent", "opened", "paid", "slot_selected", "expired", "revoked"],
);

export const consultations = pgTable("consultations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  // Null until the lead selects a slot in the booking flow.
  scheduledAt: timestamp("scheduled_at"),
  duration: integer("duration").notNull(),
  mode: consultationModeEnum("mode").notNull(),
  // Urgent (admin fast-track): the lead skips the slot queue and is connected
  // ASAP; scheduledAt is set at creation and finalization happens on pay
  // (fee case) or immediately at initiate (no-fee case).
  isUrgent: boolean("is_urgent").notNull().default(false),
  leadAttorneyId: uuid("lead_attorney_id").references(() => staff.id),
  // Required when mode = in_person.
  locationId: uuid("location_id").references(() => consultationLocations.id),
  videoLink: text("video_link"),
  // External calendar event id from the Google Meet integration.
  meetExternalId: text("meet_external_id"),
  status: consultationStatusEnum("status").notNull().default("scheduled"),
  // Fee gate (config-only this phase; payment link is a dummy).
  feeAmount: numeric("fee_amount", { precision: 10, scale: 2 }),
  feeStatus: consultationFeeStatusEnum("fee_status").notNull().default("none"),
  // Token-gated lead-facing booking link (mirrors questionnaire sends).
  bookingTokenHash: text("booking_token_hash"),
  bookingExpiresAt: timestamp("booking_expires_at"),
  bookingStatus: consultationBookingStatusEnum("booking_status"),
  preConsultationNotes: text("pre_consultation_notes"),
  attorneyNotes: text("attorney_notes"),
  outcome: consultationOutcomeEnum("outcome"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Additional attorneys/paralegals invited to a consultation (the lead attorney
// stays on consultations.leadAttorneyId).
export const consultationParticipants = pgTable("consultation_participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  consultationId: uuid("consultation_id")
    .notNull()
    .references(() => consultations.id, { onDelete: "cascade" }),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => staff.id, { onDelete: "cascade" }),
  roleSnapshot: text("role_snapshot"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Consultation = typeof consultations.$inferSelect;
export type NewConsultation = typeof consultations.$inferInsert;
export type ConsultationParticipant =
  typeof consultationParticipants.$inferSelect;
export type NewConsultationParticipant =
  typeof consultationParticipants.$inferInsert;
