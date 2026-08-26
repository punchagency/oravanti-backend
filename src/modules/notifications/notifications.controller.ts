import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { NotFoundError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { listNotifications, markNotificationRead, type NotificationRecipient } from "./notification.service";
import { db } from "../../db/client";
import { staff } from "../../db/schema/staff";
import { and, eq } from "drizzle-orm";

/**
 * Who the caller is as a notification recipient.
 *
 * Resolved from the session rather than taken from a query parameter — a
 * recipient id on the wire would let anyone read anyone else's notifications,
 * and there is no legitimate reason to read another person's.
 */
async function currentRecipient(organizationId: string, userId: string): Promise<NotificationRecipient> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.userId, userId), eq(staff.organizationId, organizationId)))
    .limit(1);

  return row ? { type: "staff", staffId: row.id } : { type: "client", userId };
}

export class NotificationsController {
  /** In-app list for the signed-in user. No FE consumer ships this phase; the API is complete so one can be added without backend work. */
  list = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, userId } = getRequestContext();
    const recipient = await currentRecipient(organizationId!, userId!);

    const rows = await listNotifications({
      organizationId: organizationId!,
      recipient,
      unreadOnly: req.query.unreadOnly === "true",
    });

    sendSuccess(res, rows, "Notifications retrieved successfully");
  });

  markRead = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const updated = await markNotificationRead(String(req.params.id), organizationId!);

    // Already-read is not an error — the row exists and is read, which is what
    // the caller asked for. Only a genuinely absent row is a 404.
    if (!updated) throw new NotFoundError("Notification not found or already read");

    sendSuccess(res, updated, "Notification marked as read");
  });
}
