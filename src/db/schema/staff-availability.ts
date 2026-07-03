import {
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { staff } from "./staff";

export const staffAvailabilityOverrideTypeEnum = pgEnum(
  "staff_availability_override_type",
  ["closed", "custom_hours"],
);

// Recurring weekly working windows. A staff member can have multiple windows
// per day (e.g. a split shift). dayOfWeek: 0 = Sunday ... 6 = Saturday.
export const staffAvailability = pgTable("staff_availability", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => staff.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Recurring intra-day unavailable windows (e.g. lunch).
export const staffAvailabilityBreaks = pgTable("staff_availability_breaks", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => staff.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  label: text("label"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Date-specific exceptions to the recurring schedule: either fully closed or
// a custom set of hours for that single date.
export const staffAvailabilityOverrides = pgTable(
  "staff_availability_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    type: staffAvailabilityOverrideTypeEnum("type").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
);

export type StaffAvailability = typeof staffAvailability.$inferSelect;
export type NewStaffAvailability = typeof staffAvailability.$inferInsert;
export type StaffAvailabilityBreak = typeof staffAvailabilityBreaks.$inferSelect;
export type NewStaffAvailabilityBreak =
  typeof staffAvailabilityBreaks.$inferInsert;
export type StaffAvailabilityOverride =
  typeof staffAvailabilityOverrides.$inferSelect;
export type NewStaffAvailabilityOverride =
  typeof staffAvailabilityOverrides.$inferInsert;
