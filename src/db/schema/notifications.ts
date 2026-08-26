import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";
import { cases } from "./cases";
import { staff } from "./staff";
import { tasks } from "./tasks";

export const notificationRecipientTypeEnum = pgEnum("notification_recipient_type", ["staff", "client"]);
export const notificationChannelEnum = pgEnum("notification_channel", ["email", "in_app", "sms"]);
export const notificationCategoryEnum = pgEnum("notification_category", [
  "task_due_soon",
  "task_overdue",
  "task_assigned",
  "case_status_changed",
]);
export const notificationStatusEnum = pgEnum("notification_status", ["pending", "sent", "failed"]);

/**
 * Minimal notification service (Decision 4): DB-backed, email wired end-to-end,
 * in-app rows persisted so a future notification center needs zero backend
 * rework, SMS honestly stubbed (logged, stays `pending`, never faked as `sent`).
 * No FE notification-center UI ships alongside this table — see
 * `.claude/workflows/03-frontend-architecture.md § Notifications`.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull().references(() => organization.id),

    recipientType: notificationRecipientTypeEnum("recipient_type").notNull(),
    recipientStaffId: uuid("recipient_staff_id").references(() => staff.id),
    // clients auth via better-auth `user`, not `staff`
    recipientClientUserId: text("recipient_client_user_id").references(() => user.id),

    channel: notificationChannelEnum("channel").notNull(),
    category: notificationCategoryEnum("category").notNull(),

    subject: text("subject"),
    body: text("body").notNull(),

    relatedCaseId: uuid("related_case_id").references(() => cases.id, { onDelete: "cascade" }),
    relatedTaskId: uuid("related_task_id").references(() => tasks.id, { onDelete: "cascade" }),

    status: notificationStatusEnum("status").notNull().default("pending"),
    sentAt: timestamp("sent_at"),
    failureReason: text("failure_reason"),
    readAt: timestamp("read_at"), // in-app read receipt — schema-ready, no FE consumer yet

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "notifications_exactly_one_recipient",
      sql`(${table.recipientStaffId} IS NOT NULL)::int + (${table.recipientClientUserId} IS NOT NULL)::int = 1`,
    ),
    index("notifications_organization_idx").on(table.organizationId),
    index("notifications_recipient_staff_idx").on(table.recipientStaffId),
    index("notifications_related_task_idx").on(table.relatedTaskId),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
