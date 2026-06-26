import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { leads } from "./leads";
import { staff } from "./staff";

export const consultationModeEnum = pgEnum('consultation_mode', ['video', 'in_person', 'phone_call']);

export const consultationStatusEnum = pgEnum('consultation_status', [
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
]);

export const consultationOutcomeEnum = pgEnum("consultation_outcome", [
  "proceed",
  "close_no_case",
  "refer_elsewhere",
  "follow_up",
]);

export const consultations = pgTable("consultations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  scheduledAt: timestamp("scheduled_at").notNull(),
  duration: integer("duration").notNull(),
  mode: consultationModeEnum("mode").notNull(),
  leadAttorneyId: uuid("lead_attorney_id").references(() => staff.id),
  videoLink: text("video_link"),
  status: consultationStatusEnum("status").notNull().default("scheduled"),
  preConsultationNotes: text("pre_consultation_notes"),
  attorneyNotes: text("attorney_notes"),
  outcome: consultationOutcomeEnum("outcome"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Consultation = typeof consultations.$inferSelect;
export type NewConsultation = typeof consultations.$inferInsert;
