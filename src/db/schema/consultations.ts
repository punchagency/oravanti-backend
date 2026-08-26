import {
  boolean,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
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

/**
 * The statuses where the consultation has not happened and can still be
 * cancelled — as opposed to `completed`, `cancelled` and `no_show`, which are
 * terminal.
 *
 * Lives beside the enum rather than in a service because two services need it
 * and importing between them is a cycle: `invoices.service` builds a SQL
 * predicate from it at module scope, and `consultation-billing.service` already
 * imports `invoices.service`.
 */
export const LIVE_CONSULTATION_STATUSES = [
  "pending_payment",
  "awaiting_slot_selection",
  "scheduled",
  "in_progress",
] as const;

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

// Instant ("start now") consultations: how the fee is collected.
export const consultationPaymentTimingEnum = pgEnum(
  "consultation_payment_timing",
  [
    // Payment link sent immediately; the consultation begins on payment.
    "pay_now",
    // Consultation begins now; payment link emailed at completion.
    "invoice_after",
    // Consultation begins now; staff marks the payment received manually.
    "pay_in_person",
  ],
);

export const consultations = pgTable("consultations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  // Set when this consultation is a follow-up of a prior (completed) one.
  parentConsultationId: uuid("parent_consultation_id").references(
    (): AnyPgColumn => consultations.id,
  ),
  // Null until the lead selects a slot in the booking flow.
  scheduledAt: timestamp("scheduled_at"),
  duration: integer("duration").notNull(),
  mode: consultationModeEnum("mode").notNull(),
  // Urgent (admin fast-track): the lead skips the slot queue and is connected
  // ASAP; scheduledAt is set at creation and finalization happens on pay
  // (fee case) or immediately at initiate (no-fee case).
  isUrgent: boolean("is_urgent").notNull().default(false),
  // Instant consultation ("start now"): begins immediately rather than being
  // scheduled (or at payment time for pay_now).
  isInstant: boolean("is_instant").notNull().default(false),
  // Only set for instant consultations.
  paymentTiming: consultationPaymentTimingEnum("payment_timing"),
  /**
   * When this consultation's deposit balance falls due, in days after the call.
   *
   * Snapshotted from `consultation_settings.balance_due_days` at booking — or
   * from whoever scheduled it, when the firm's mode is `custom`. Stored rather
   * than re-read because the balance date is recomputed when the lead picks a
   * slot, by which point the firm's setting may have moved and a per-
   * consultation choice would otherwise be silently discarded.
   */
  balanceDueDays: integer("balance_due_days"),
  // Emergency rate multiplier applied to the standard fee (display/audit; the
  // multiplied amount is persisted in feeAmount).
  isEmergency: boolean("is_emergency").notNull().default(false),
  emergencyMultiplier: numeric("emergency_multiplier", {
    precision: 5,
    scale: 2,
  }),
  // Auto-send the intake questionnaire when this consultation completes (only
  // if the lead has never been sent one).
  autoSendQuestionnaire: boolean("auto_send_questionnaire")
    .notNull()
    .default(false),
  leadAttorneyId: uuid("lead_attorney_id").references(() => staff.id),
  // Required when mode = in_person.
  locationId: uuid("location_id").references(() => consultationLocations.id),
  videoLink: text("video_link"),
  // External calendar event id from the Google Meet integration.
  meetExternalId: text("meet_external_id"),
  status: consultationStatusEnum("status").notNull().default("scheduled"),
  /**
   * Legacy fee columns. The INVOICE is authoritative once `invoiceId` is set —
   * `feeStatus` then means whatever the ledger says, not an enum somebody
   * flipped. These stay populated for consultations that predate invoicing,
   * which is why reads coalesce rather than switch.
   */
  feeAmount: numeric("fee_amount", { precision: 10, scale: 2 }),
  feeStatus: consultationFeeStatusEnum("fee_status").notNull().default("none"),
  /**
   * The invoice raised for this fee. Deliberately not a foreign key with a
   * cascade: voiding or removing an invoice must never take the consultation
   * with it, and the leads module already keeps `clientId`/`convertedCaseId` as
   * unlinked ids for the same reason.
   */
  invoiceId: uuid("invoice_id"),
  // Token-gated lead-facing booking link (mirrors questionnaire sends).
  bookingTokenHash: text("booking_token_hash"),
  bookingExpiresAt: timestamp("booking_expires_at"),
  bookingStatus: consultationBookingStatusEnum("booking_status"),
  preConsultationNotes: text("pre_consultation_notes"),
  attorneyNotes: text("attorney_notes"),
  outcome: consultationOutcomeEnum("outcome"),
  // Cancellation audit (set by the cancel flow, which also revokes the booking
  // link and removes the Meet event).
  cancelledAt: timestamp("cancelled_at"),
  cancellationReason: text("cancellation_reason"),
  // Who booked / cancelled this consultation. Distinct from leadAttorneyId,
  // which is who it is *with*.
  scheduledById: uuid("scheduled_by_id").references(() => staff.id),
  cancelledById: uuid("cancelled_by_id").references(() => staff.id),

  // Reminder bookkeeping. The reminders themselves are `notifications` rows
  // with a deterministic dedupeKey, so these columns are not the schedule — the
  // ledger is. They record what actually went out, which is what the
  // consultation card needs to display without joining across.
  //
  // remindersScheduledAt is the "we have queued these" marker: a reschedule
  // cancels and re-queues, and a consultation that was never in a schedulable
  // state has it null.
  reminder24hSentAt: timestamp("reminder_24h_sent_at"),
  reminder1hSentAt: timestamp("reminder_1h_sent_at"),
  remindersScheduledAt: timestamp("reminders_scheduled_at"),

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
