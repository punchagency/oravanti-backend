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
  // Present in the model but kept disabled for now (SMS not yet supported).
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ConsultationSettings = typeof consultationSettings.$inferSelect;
export type NewConsultationSettings = typeof consultationSettings.$inferInsert;
