import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { notifications } from "../../db/schema/notifications";
import {
  isEmailDeliveryTrackingConfigured,
} from "../../notifications/sms/sms.provider";
import {
  buildPaginatedResponse,
  getPaginationOffset,
  type PaginationParams,
} from "../../utils/pagination";

/**
 * Read side of the notification ledger — the "why didn't they get it" endpoint.
 *
 * Deliberately includes skipped and failed rows. Those are the interesting
 * ones: a firm asking why a client never received the questionnaire wants
 * "Skipped — no SMS consent", not an empty list that looks the same as never
 * having tried.
 */

export type NotificationFilters = {
  leadId?: string;
  clientId?: string;
  invoiceId?: string;
  caseId?: string;
};

/**
 * Whether email delivery confirmations are possible at all.
 *
 * The UI needs this to tell apart an email row that is legitimately final at
 * `sent` — which is every email in development, where the SMTP transport has no
 * webhooks — from one that is genuinely stuck. Without it, someone spends an
 * afternoon debugging correct behaviour.
 */
export const deliveryTrackingStatus = () => ({
  email: isEmailDeliveryTrackingConfigured(),
});

export class NotificationsService {
  list = async (
    organizationId: string,
    filters: NotificationFilters,
    pagination: PaginationParams,
  ) => {
    const conditions: SQL[] = [eq(notifications.organizationId, organizationId)];

    if (filters.leadId) conditions.push(eq(notifications.leadId, filters.leadId));
    if (filters.clientId)
      conditions.push(eq(notifications.clientId, filters.clientId));
    if (filters.invoiceId)
      conditions.push(eq(notifications.invoiceId, filters.invoiceId));
    if (filters.caseId) conditions.push(eq(notifications.caseId, filters.caseId));

    const where = and(...conditions);

    const [rows, [totals]] = await Promise.all([
      db
        .select({
          id: notifications.id,
          event: notifications.event,
          channel: notifications.channel,
          status: notifications.status,
          recipientName: notifications.recipientName,
          recipientAddress: notifications.recipientAddress,
          subject: notifications.subject,
          skipReason: notifications.skipReason,
          failureReason: notifications.failureReason,
          attemptCount: notifications.attemptCount,
          sendAt: notifications.sendAt,
          sentAt: notifications.sentAt,
          deliveredAt: notifications.deliveredAt,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        // Newest first, matching notifications_org_created_idx.
        .orderBy(desc(notifications.createdAt))
        .where(where)
        .limit(pagination.limit)
        .offset(getPaginationOffset(pagination)),
      db.select({ value: count() }).from(notifications).where(where),
    ]);

    return buildPaginatedResponse(rows, {
      ...pagination,
      total: totals?.value ?? 0,
    });
  };
}
