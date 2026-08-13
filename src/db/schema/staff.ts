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
import { portalStatusEnum } from "../../modules/auth/enums";

export const staffRoleEnum = pgEnum("staff_role", [
  "admin",
  "attorney",
  "paralegal",
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

  role: staffRoleEnum("role"),
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

// export const staff = pgTable("staff", {
//   id: uuid("id").primaryKey().defaultRandom(),
//   organizationId: text("organization_id")
//     .notNull()
//     .references(() => organization.id),
//   userId: text("user_id"),
//   firstName: text("first_name").notNull(),
//   lastName: text("last_name").notNull(),
//   email: text("email").notNull().unique(),
//   phone: text("phone").notNull(),
//   role: staffRoleEnum("role").notNull(),
//   status: staffStatusEnum("status").notNull().default("active"),
//   maxCaseload: integer("max_caseload").notNull().default(7),
//   startDate: date("start_date").notNull(),
//   performanceScore: integer("performance_score").default(0),
//   certificationsCount: integer("certifications_count").default(0),
//   activeCases: integer("active_cases").default(0),
//   totalCases: integer("total_cases").default(0),
//   monthlySalary: numeric("monthly_salary", { precision: 10, scale: 2 }).default(
//     "0",
//   ),
//   hourlyRate: numeric("hourly_rate", { precision: 8, scale: 2 }).default("0"),
//   avatarUrl: text("avatar_url"),
//   createdAt: timestamp("created_at").notNull().defaultNow(),
//   updatedAt: timestamp("updated_at").notNull().defaultNow(),
//   isActive: boolean("is_active").default(true).notNull(),
//   joinedAt: timestamp("joined_at").defaultNow().notNull(),
// });
