import { and, eq, like, sql } from "drizzle-orm";
import { env } from "../config/env";
import { systemDb } from "../db/client";
import { organization } from "../db/schema/auth-schema";
import { consultationSettings } from "../db/schema/consultation-settings";
import {
  notifications,
  type NewNotification,
} from "../db/schema/notifications";
import { toE164 } from "../utils/phone";
import { getEventDef, type NotificationEventKey } from "./events";
import {
  deferForQuietHours,
  getFirmPreferences,
  isFirmSmsEnabled,
  resolveChannelDecision,
  type FirmContext,
} from "./preferences.service";
import { resolveRecipient } from "./recipients";
import { TEMPLATES, type TemplateMeta } from "./templates";
import { ATTACHMENTS_KEY } from "./types";
import type {
  NotificationChannel,
  NotifyInput,
  NotifyResult,
  NotifyResultRow,
  ResolvedRecipient,
} from "./types";
import { createModuleLogger, LogEvent } from "../lib/logging/log";

const log = createModuleLogger("notifications.notification_service");

/**
 * The entry point every caller uses instead of touching a provider.
 *
 * What it buys over the `sendEmail({...}).catch(console.error)` it replaces:
 * a persisted row per recipient per channel, a recorded REASON when a channel
 * is deliberately not used, retries with backoff, and one place where consent,
 * suppression and firm preferences are checked rather than thirty places where
 * they are not.
 *
 * A blocked channel still writes a row, with `status: "skipped"`. That is the
 * point of the whole design: "we did not send, because they opted out" and "we
 * sent and it vanished" look identical in a log file and completely different
 * to a firm asking what happened.
 */
export const notify = async (input: NotifyInput): Promise<NotifyResult> => {
  const def = getEventDef(input.event);
  const firm = await loadFirmContext(input.organizationId);

  // Per-send pickers narrow; they can never widen past what the event supports.
  const requested = input.channels ?? def.channels;
  const channels = def.channels.filter((channel) =>
    requested.includes(channel),
  ) as NotificationChannel[];

  const sendAt = input.sendAt
    ? deferForQuietHours(input.sendAt, firm.timezone)
    : null;

  const rows: NewNotification[] = [];

  for (const recipient of input.recipients) {
    const resolved = await resolveRecipient(input.organizationId, recipient);
    // A recipient that no longer exists is not a notification with a skip
    // reason — there is nobody to record it against.
    if (!resolved) continue;

    for (const channel of channels) {
      rows.push(
        await buildRow({ input, def, firm, channel, resolved, sendAt }),
      );
    }
  }

  if (!rows.length) return { notifications: [] };

  /**
   * One insert, conflicting on the partial unique index over
   * (organization_id, dedupe_key).
   *
   * This is where idempotency lives. Scheduling the same consultation reminder
   * twice — a reschedule racing a sweep, a retried request — is a database
   * no-op rather than a check some caller had to remember to write.
   */
  const inserted = await systemDb
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing()
    .returning({
      id: notifications.id,
      channel: notifications.channel,
      status: notifications.status,
      skipReason: notifications.skipReason,
      sendAt: notifications.sendAt,
    });

  // Enqueued after the insert, never inside it: a job that starts before its
  // row is committed would find nothing to send.
  const { enqueueNotification } = await import("../queue/queues");

  const result: NotifyResultRow[] = [];

  for (const row of inserted) {
    if (row.status !== "pending") {
      result.push({
        id: row.id,
        channel: row.channel,
        status: row.status,
        skipReason: row.skipReason,
      });
      continue;
    }

    const delayMs = row.sendAt
      ? Math.max(0, row.sendAt.getTime() - Date.now())
      : 0;

    const jobId = await enqueueNotification(
      { id: row.id, organizationId: input.organizationId },
      delayMs,
    ).catch((error) => {
      // Redis being down must not fail the caller's request. The row stays
      // `pending` and the sweep picks it up.
      log.failure(LogEvent.NOTIFICATION_ENQUEUE_FAILED, error, {
        notificationId: row.id,
      });
      return undefined;
    });

    if (jobId) {
      await systemDb
        .update(notifications)
        .set({ status: "queued", jobId, updatedAt: new Date() })
        .where(eq(notifications.id, row.id));
    }

    result.push({
      id: row.id,
      channel: row.channel,
      status: jobId ? "queued" : "pending",
      skipReason: null,
    });
  }

  return { notifications: result };
};

/**
 * Builds one row, deciding as it goes whether it will ever be sent.
 *
 * Rendering happens here rather than in the worker so that a template failure
 * surfaces at the call site, and so the stored subject/body is exactly what was
 * intended at the moment the event happened.
 */
const buildRow = async (args: {
  input: NotifyInput;
  def: ReturnType<typeof getEventDef>;
  firm: FirmContext;
  channel: NotificationChannel;
  resolved: ResolvedRecipient;
  sendAt: Date | null;
}): Promise<NewNotification> => {
  const { input, def, firm, channel, resolved, sendAt } = args;

  const base: NewNotification = {
    organizationId: input.organizationId,
    event: input.event,
    tier: def.tier,
    channel,
    recipientType: resolved.type,
    recipientId: resolved.id,
    recipientName: resolved.name,
    // Attachments ride inside the payload under a reserved key rather than in
    // a column of their own: they are part of what this message *is*, so they
    // have to survive the same re-render the body does. Only keys are stored —
    // the bytes are fetched when the worker sends.
    payload: {
      ...(input.context as Record<string, unknown>),
      ...(input.attachments?.length
        ? { [ATTACHMENTS_KEY]: input.attachments }
        : {}),
    },
    dedupeKey: input.dedupeKey
      ? // Scoped per channel: an event that goes out by both email and SMS
        // produces two rows, and one dedupe key cannot cover both without the
        // second silently colliding with the first.
        `${input.dedupeKey}:${channel}`
      : null,
    leadId: input.scenario?.leadId ?? null,
    clientId: input.scenario?.clientId ?? null,
    caseId: input.scenario?.caseId ?? null,
    invoiceId: input.scenario?.invoiceId ?? null,
    consultationId: input.scenario?.consultationId ?? null,
    sentById: input.actorStaffId ?? null,
    sendAt,
  };

  const decision = await resolveChannelDecision({
    def,
    channel,
    recipient: resolved,
    firm,
  });

  if (!decision.allowed) {
    return { ...base, status: "skipped", skipReason: decision.skipReason };
  }

  // SMS addresses are normalised exactly here — the one place raw stored text
  // becomes a dialable number. A number nobody can parse is a recipient we
  // cannot reach, recorded as such rather than handed to a provider to reject.
  let address: string | null = null;
  if (channel === "sms") {
    address = toE164(resolved.rawPhone);
    if (!address) {
      return { ...base, status: "skipped", skipReason: "unparseable_phone" };
    }
  } else if (channel === "email") {
    address = resolved.email;
  }

  const meta: TemplateMeta = {
    firmName: firm.firmName,
    recipientName: resolved.name,
    appUrl: env.FRONTEND_APP_URL,
    timezone: firm.timezone,
  };

  const template = TEMPLATES[input.event as NotificationEventKey];
  const rendered = renderChannel(template, channel, input.context, meta);

  if (!rendered) {
    // The catalog claims this channel but no template implements it. Recorded
    // rather than sent blank; the check asserts this never happens.
    return { ...base, status: "skipped", skipReason: "no_template" };
  }

  return {
    ...base,
    recipientAddress: address,
    subject: rendered.subject,
    body: rendered.body,
    status: "pending",
  };
};

const renderChannel = (
  template: (typeof TEMPLATES)[NotificationEventKey] | undefined,
  channel: NotificationChannel,
  context: Record<string, unknown>,
  meta: TemplateMeta,
): { subject: string | null; body: string | null } | null => {
  if (!template) return null;

  if (channel === "email" && template.email) {
    const { subject } = template.email(context, meta);
    // Email HTML is not persisted — see notifications.payload. The body is
    // re-rendered from the context at send time.
    return { subject, body: null };
  }

  if (channel === "sms" && template.sms) {
    return { subject: null, body: template.sms(context, meta) };
  }

  if (channel === "in_app" && template.inApp) {
    const { title, body } = template.inApp(context, meta);
    return { subject: title, body };
  }

  return null;
};

/** Read once per notify() — a firm-wide alert should not read settings per recipient. */
const loadFirmContext = async (
  organizationId: string,
): Promise<FirmContext> => {
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

  const [smsEnabled, preferences] = await Promise.all([
    isFirmSmsEnabled(organizationId),
    getFirmPreferences(organizationId),
  ]);

  return {
    firmName: org?.name ?? "Your law firm",
    timezone: settings?.timezone ?? "UTC",
    smsEnabled,
    preferences,
  };
};

/**
 * Cancel scheduled notifications matching a dedupe key prefix.
 *
 * Used when the thing they were about changes — a consultation moved or was
 * cancelled. Removes the queued jobs and marks the rows `cancelled` rather than
 * deleting them: "a reminder was scheduled and then called off" is part of the
 * record.
 */
export const cancelNotifications = async (
  organizationId: string,
  dedupeKeyPrefix: string,
): Promise<number> => {
  const pending = await systemDb
    .select({ id: notifications.id, jobId: notifications.jobId })
    .from(notifications)
    .where(
      and(
        eq(notifications.organizationId, organizationId),
        like(notifications.dedupeKey, `${dedupeKeyPrefix}%`),
        sql`${notifications.status} IN ('pending', 'queued')`,
      ),
    );

  if (!pending.length) return 0;

  const { cancelNotificationJob } = await import("../queue/queues");

  for (const row of pending) {
    await cancelNotificationJob(row.id).catch((error) =>
      log.failure(LogEvent.NOTIFICATION_CANCEL_FAILED, error, {
        notificationId: row.id,
      }),
    );
  }

  await systemDb
    .update(notifications)
    .set({
      status: "cancelled",
      skipReason: "cancelled",
      /**
       * Cancelling RELEASES the dedupe key.
       *
       * The row is kept — "this was scheduled and then called off" is part of
       * the record — but its key is not, because the key's only job was to stop
       * a live send being duplicated and there is no longer a live send.
       *
       * Without this, cancel-then-reschedule silently loses the new
       * notification: the insert would collide with the cancelled row on the
       * partial unique index and be dropped by onConflictDoNothing, leaving a
       * consultation with no reminders at all. That failure is invisible —
       * nothing errors, a reminder simply never arrives.
       */
      dedupeKey: null,
      updatedAt: new Date(),
    })
    .where(
      sql`${notifications.id} IN (${sql.join(
        pending.map((row) => sql`${row.id}`),
        sql`, `,
      )})`,
    );

  return pending.length;
};
