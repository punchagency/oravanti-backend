import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { user } from "../../db/schema/auth-schema";
import {
  notifications,
  type notificationCategoryEnum,
  type notificationChannelEnum,
} from "../../db/schema/notifications";
import { staff } from "../../db/schema/staff";
import { createModuleLogger } from "../../lib/logging/log";
import { emailService } from "../../utils/email/email.service";
import { recordAuditEvent } from "../shared/audit.service";

const log = createModuleLogger("notifications.service");

type Category = (typeof notificationCategoryEnum.enumValues)[number];
type Channel = (typeof notificationChannelEnum.enumValues)[number];

export type NotificationRecipient =
  | { type: "staff"; staffId: string }
  | { type: "client"; userId: string };

export type DispatchParams = {
  organizationId: string;
  recipient: NotificationRecipient;
  channel: Channel;
  category: Category;
  subject?: string;
  body: string;
  relatedCaseId?: string;
  relatedTaskId?: string;
};

/**
 * Categories worth an audit row.
 *
 * Only case-facing events — a routine `task_due_soon` reminder fires on a
 * timer for every open task and would flood the trail with rows nobody reads,
 * the same reason a cron tick isn't individually audited.
 */
const AUDITED_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "task_assigned",
  "case_status_changed",
]);

async function recipientEmail(recipient: NotificationRecipient): Promise<string | null> {
  if (recipient.type === "staff") {
    const [row] = await db
      .select({ email: staff.email, orgEmail: staff.orgEmail })
      .from(staff)
      .where(eq(staff.id, recipient.staffId))
      .limit(1);
    return row?.orgEmail ?? row?.email ?? null;
  }

  const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, recipient.userId)).limit(1);
  return row?.email ?? null;
}

/**
 * Persists a notification and delivers it on the requested channel.
 *
 * The row is written first and always, whatever the channel does next — an
 * in-app notification centre that does not exist yet can therefore be built
 * against a complete history with no backend rework, and a failed send leaves
 * evidence rather than vanishing.
 *
 * Per-channel behaviour:
 * - `email` — sent through the existing sender, then marked `sent`.
 * - `in_app` — persistence *is* the delivery; there is no push mechanism.
 * - `sms`  — logged and left `pending`. Not implemented, and deliberately never
 *   marked `sent`: a fake success here would read as "the client was told" in
 *   an audit six months from now.
 */
export async function dispatchNotification(params: DispatchParams): Promise<void> {
  const [row] = await db
    .insert(notifications)
    .values({
      organizationId: params.organizationId,
      recipientType: params.recipient.type,
      recipientStaffId: params.recipient.type === "staff" ? params.recipient.staffId : null,
      recipientClientUserId: params.recipient.type === "client" ? params.recipient.userId : null,
      channel: params.channel,
      category: params.category,
      subject: params.subject ?? null,
      body: params.body,
      relatedCaseId: params.relatedCaseId ?? null,
      relatedTaskId: params.relatedTaskId ?? null,
      status: "pending",
    })
    .returning();

  const markSent = () => db.update(notifications).set({ status: "sent", sentAt: new Date() }).where(eq(notifications.id, row.id));

  const markFailed = (reason: string) =>
    db.update(notifications).set({ status: "failed", failureReason: reason }).where(eq(notifications.id, row.id));

  switch (params.channel) {
    case "email": {
      const to = await recipientEmail(params.recipient);
      if (!to) {
        await markFailed("No email address on file for recipient");
        log.warn("notification.failed", { notificationId: row.id, reason: "no_email" });
        return;
      }
      try {
        await emailService.sendEmail({
          to,
          subject: params.subject ?? "Notification",
          html: params.body,
        });
        await markSent();
      } catch (err) {
        await markFailed(err instanceof Error ? err.message : "Unknown send failure");
        log.failure("notification.failed", err, { notificationId: row.id });
        return;
      }
      break;
    }

    case "in_app":
      await markSent();
      break;

    case "sms":
      log.warn("notification.sms_not_implemented", { notificationId: row.id });
      return; // stays `pending` — see the doc comment.
  }

  log.action("notification.dispatched", {
    notificationId: row.id,
    channel: params.channel,
    category: params.category,
  });

  if (AUDITED_CATEGORIES.has(params.category)) {
    await recordAuditEvent({
      action: "notification.sent",
      entityType: "notification",
      entityId: row.id,
      organizationId: params.organizationId,
      ...(params.relatedCaseId ? { parentEntityType: "case" as const, parentEntityId: params.relatedCaseId } : {}),
      summary: params.subject ?? `${params.category} notification sent`,
      metadata: { channel: params.channel, category: params.category },
    });
  }
}

/** In-app notification list for the signed-in recipient. */
export async function listNotifications(params: {
  organizationId: string;
  recipient: NotificationRecipient;
  unreadOnly?: boolean;
}) {
  const recipientMatch =
    params.recipient.type === "staff"
      ? eq(notifications.recipientStaffId, params.recipient.staffId)
      : eq(notifications.recipientClientUserId, params.recipient.userId);

  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.organizationId, params.organizationId),
        recipientMatch,
        ...(params.unreadOnly ? [isNull(notifications.readAt)] : []),
      ),
    )
    .orderBy(desc(notifications.createdAt));
}

/** Idempotent: re-reading an already-read notification keeps the original timestamp. */
export async function markNotificationRead(id: string, organizationId: string) {
  const [updated] = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.organizationId, organizationId), isNull(notifications.readAt)))
    .returning();
  return updated ?? null;
}
