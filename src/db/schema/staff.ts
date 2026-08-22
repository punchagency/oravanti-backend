import {
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";
import { portalStatusEnum } from "./enums";

// The set of *default* roles a firm's billing-rate table
// (`src/db/schema/billing-rates.ts`) can configure a rate for. Not used by
// `staff.role` itself (see below) — a firm-defined custom role has no
// billing-rate row today, which is a known gap, not something this enum
// should paper over by accepting arbitrary strings.
export const staffRoleEnum = pgEnum("staff_role", [
  "owner",
  "admin",
  "attorney",
  "paralegal",
  "legal_assistant",
  "receptionist",
]);

export const staffStatusEnum = pgEnum("staff_status", [
  "active",
  "inactive",
  "on_leave",
  "recertify_required",
  "pending_invitation",
]);

export const staff = pgTable("staff", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Relations: Linked to Better Auth's Org plugin and Core User definitions
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .references(() => user.id, { onDelete: "cascade" })
    .unique(),

  email: text("email"),
  barNumber: text("bar_number"),
  timezone: text("timezone"),

  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone"),

  // Workspace Context
  jobTitle: text("job_title").default("Staff Member"),
  status: staffStatusEnum("status").notNull().default("active"),

  // Not the source of truth for authorization — that's better-auth's
  // `member.role` (see `src/auth/permissions.ts`), which supports multiple
  // comma-separated roles per member. This is only a best-effort, single-
  // value "primary role" projection of that (see `organizationHooks` in
  // `src/auth/index.ts`) for the read sites that display/group by "a" role
  // rather than checking a real permission. Free text, not `staffRoleEnum`,
  // because the primary role can be a firm-defined custom role name that
  // enum was never meant to enumerate.
  role: text("role"),
  startDate: timestamp("start_date"),
  avatarUrl: text("avatar_url"),
  monthlySalary: numeric("monthly_salary", { precision: 10, scale: 2 }).default(
    "0",
  ),
  hourlyRate: numeric("hourly_rate", { precision: 8, scale: 2 }).default("0"),

  // Org-specific fields
  orgEmail: text("org_email"),
  maxCaseload: integer("max_caseload").default(7),
  tempPassword: text("temp_password"),
  portalStatus: portalStatusEnum("portal_status").notNull().default("none"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Staff = typeof staff.$inferSelect;
export type NewStaff = typeof staff.$inferInsert;
