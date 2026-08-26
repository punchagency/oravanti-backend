import { Worker } from "bullmq";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { systemDb } from "../../db/client";
import { organization } from "../../db/schema/auth-schema";
import { consultationSettings } from "../../db/schema/consultation-settings";
import { notifications } from "../../db/schema/notifications";
import {
  isEmailDeliveryTrackingConfigured,
  getSmsProvider,
} from "../../notifications/sms/sms.provider";
import { TEMPLATES, type TemplateMeta } from "../../notifications/templates";
import type { NotificationEventKey } from "../../notifications/events";
import { emailService } from "../../utils/email/email.service";
import { redisConnection } from "../connection";
import {
  enqueueNotification,
  NOTIFICATIONS_QUEUE,
  type NotificationJob,
} from "../queues";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";

const log = createModuleLogger("queue.notification_worker");

/**
 * Delivers one notification, whatever its channel.
 *
 * Exported so an HTTP "send now" or "resend" path and the queue share one code
 * path — the same idiom as sendQuestionnaireReminder. Returns false when
 * nothing was sent, which is a normal outcome rather than a failure.
 *
 * RLS note: this runs in a worker, where no AsyncLocalStorage request context
 * exists. Every query therefore uses `systemDb` with an explicit organizationId
 * predicate rather than the `db` proxy, which would silently fall back to
 * systemDb anyway and hide the scoping. Introducing per-job tenant connections
 * instead would leak them: createTenantDb opens a fresh unpooled connection per
 * call and nothing in a worker closes it.
 */
export const dispatchNotification = async (
  notificationId: string,
): Promise<boolean> => {
  /**
   * Claim before acting.
   *
   * BullMQ is at-least-once, so two attempts can overlap. This conditional
   * update is the only guard against sending twice: whichever attempt flips the
   * status owns the send, and the other gets zero rows back and stops. The same
   * pattern the payment webhook uses to make redelivery safe.
   *
   * A residual window remains — the provider accepts the message and the
   * process dies before we record it — which a retry can turn into a duplicate.
   * That costs a fraction of a cent and is strictly better than the
   * alternative, which is dropping sends whenever a worker restarts.
   */
  const [claimed] = await systemDb
    .update(notifications)
    .set({
      status: "sending",
      attemptCount: sql`${notifications.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notifications.id, notificationId),
        sql`${notifications.status} IN ('pending', 'queued', 'failed')`,
      ),
    )
    .returning();

  if (!claimed) return false;

  try {
    const meta = await loadMeta(claimed.organizationId, claimed.recipientName);
    const template = TEMPLATES[claimed.event as NotificationEventKey];
    const context = (claimed.payload ?? {}) as Record<string, unknown>;

    switch (claimed.channel) {
      case "email": {
        if (!claimed.recipientAddress || !template?.email) {
          return await markFailed(notificationId, "missing address or template");
        }

        // Re-rendered from the persisted context rather than stored HTML, so a
        // retry produces the same message and a fixed template produces a
        // fixed one.
        const { subject, html } = template.email(context, meta);

        const { providerMessageId } = await emailService.sendEmail({
          to: claimed.recipientAddress,
          subject,
          html,
        });

        await systemDb
          .update(notifications)
          .set({
            status: "sent",
            sentAt: new Date(),
            providerMessageId,
            // In development the transport is Gmail SMTP, which never calls
            // back, so this row is final at `sent`. Recorded so the UI can say
            // that rather than showing a row apparently stuck.
            providerStatus: isEmailDeliveryTrackingConfigured()
              ? null
              : "no_delivery_tracking",
            updatedAt: new Date(),
          })
          .where(eq(notifications.id, notificationId));

        return true;
      }

      case "sms": {
        if (!claimed.recipientAddress || !claimed.body) {
          return await markFailed(notificationId, "missing address or body");
        }

        const provider = getSmsProvider();
        // No callback URL is passed: each provider builds its own from its own
        // base URL and its own route, because the field name differs
        // (statusCallback vs webhook_url) and that is vendor knowledge.
        const { providerMessageId, providerStatus } = await provider.sendSms({
          to: claimed.recipientAddress,
          body: claimed.body,
        });

        await systemDb
          .update(notifications)
          .set({
            status: "sent",
            sentAt: new Date(),
            providerMessageId,
            // Same shape as the email branch: a provider that cannot report
            // delivery leaves a row final at `sent`, and saying so beats
            // leaving it looking stuck.
            providerStatus: provider.deliveryTrackingEnabled
              ? providerStatus
              : "no_delivery_tracking",
            updatedAt: new Date(),
          })
          .where(eq(notifications.id, notificationId));

        return true;
      }

      case "in_app": {
        // The row IS the delivery. Nothing leaves the system; the inbox reads
        // these back and stamps readAt.
        await systemDb
          .update(notifications)
          .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
          .where(eq(notifications.id, notificationId));

        return true;
      }
    }
  } catch (error) {
    // Rethrown after recording, so BullMQ retries with its backoff. The row
    // sits at `failed` in between, which is also what the claim above allows a
    // retry to pick back up.
    await markFailed(
      notificationId,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  return false;
};

const markFailed = async (id: string, reason: string): Promise<boolean> => {
  await systemDb
    .update(notifications)
    .set({
      status: "failed",
      failureReason: reason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(notifications.id, id));
  return false;
};

const loadMeta = async (
  organizationId: string,
  recipientName: string | null,
): Promise<TemplateMeta> => {
  const [org] = await systemDb
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);

  const [settings] = await systemDb
    .select({ timezone: consultationSettings.timezone })
    .from(consultationSettings)
    .where(eq(consultationSettings.organizationId, organizationId))
    .limit(1);

  return {
    firmName: org?.name ?? "Your law firm",
    recipientName: recipientName ?? "",
    appUrl: env.FRONTEND_APP_URL,
    timezone: settings?.timezone ?? "UTC",
  };
};

export const createNotificationWorker = () =>
  new Worker<NotificationJob>(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      await dispatchNotification(job.data.notificationId);
    },
    { connection: redisConnection },
  );

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** How far ahead to look, so a due send is picked up before it is late. */
const SWEEP_LOOKAHEAD_MS = 5 * 60 * 1000;

/**
 * Re-enqueues notifications whose BullMQ job went missing.
 *
 * Delayed jobs live only in Redis. A flush, a restart without persistence, or a
 * failed enqueue during an outage silently loses every pending consultation
 * reminder — and the failure looks exactly like nothing happening, which is the
 * hardest kind to notice.
 *
 * Deterministic job ids make this safe to run blindly: re-adding a job that
 * still exists is a no-op. Same idea as startAiScanReconciliation.
 */
export const startNotificationSweep = () =>
  setInterval(async () => {
    try {
      const due = await systemDb
        .select({
          id: notifications.id,
          organizationId: notifications.organizationId,
          sendAt: notifications.sendAt,
        })
        .from(notifications)
        .where(
          and(
            sql`${notifications.status} IN ('pending', 'queued')`,
            or(
              isNull(notifications.sendAt),
              lte(
                notifications.sendAt,
                new Date(Date.now() + SWEEP_LOOKAHEAD_MS),
              ),
            ),
          ),
        )
        .limit(500);

      for (const row of due) {
        const delayMs = row.sendAt
          ? Math.max(0, row.sendAt.getTime() - Date.now())
          : 0;
        await enqueueNotification(
          { id: row.id, organizationId: row.organizationId },
          delayMs,
        );
      }

      if (due.length) {
        log.info(LogEvent.NOTIFICATION_SWEEP_COMPLETED, {
          reEnqueued: due.length,
        });
      }
    } catch (error) {
      log.failure(LogEvent.NOTIFICATION_SWEEP_FAILED, error);
    }
  }, SWEEP_INTERVAL_MS);
