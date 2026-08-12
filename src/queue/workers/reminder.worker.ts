import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { leads } from "../../db/schema/leads";
import {
  questionnaireResponses,
  questionnaireSends,
} from "../../db/schema/questionnaires";
import { notify } from "../../notifications/notification.service";
import { redisConnection } from "../connection";
import {
  QUESTIONNAIRE_REMINDERS_QUEUE,
  type QuestionnaireReminderJob,
} from "../queues";

/**
 * Build + send a reminder for an outstanding questionnaire. Shared by the worker
 * (auto reminders) and the manual "Send reminder" endpoint.
 *
 * Returns false when no reminder was sent (already submitted / send gone).
 */
export const sendQuestionnaireReminder = async (
  sendId: string,
): Promise<boolean> => {
  const [send] = await db
    .select()
    .from(questionnaireSends)
    .where(eq(questionnaireSends.id, sendId))
    .limit(1);

  if (!send || send.status === "submitted" || send.status === "revoked") {
    return false;
  }

  const [response] = await db
    .select()
    .from(questionnaireResponses)
    .where(eq(questionnaireResponses.questionnaireSendId, sendId))
    .limit(1);

  if (response?.status === "submitted") return false;

  if (!send.leadId) return false;
  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, send.leadId))
    .limit(1);
  if (!lead) return false;

  // Delivered on the same channels the original send used: a lead who was only
  // ever emailed should not first hear from us by text at reminder time.
  const channels = ((send.deliveryChannels as string[] | null) ?? ["email"]) as (
    | "email"
    | "sms"
  )[];

  await notify({
    organizationId: lead.organizationId,
    event: "questionnaire_reminder",
    recipients: [{ type: "lead", id: lead.id }],
    // No link: the access token is not recoverable here, and the previous
    // implementation said the same thing in prose. The template falls back to
    // "contact the office" when it has none.
    context: {},
    channels,
    scenario: { leadId: lead.id },
    // Keyed on the reminder count, so a manual "send reminder" after an
    // automatic one is a new message rather than a silent no-op.
    dedupeKey: `questionnaire-reminder-${sendId}-${send.lastReminderAt?.getTime() ?? 0}`,
  }).catch((error: unknown) => console.error("[reminder] notify failed", error));

  await db
    .update(questionnaireSends)
    .set({ lastReminderAt: new Date(), updatedAt: new Date() })
    .where(eq(questionnaireSends.id, sendId));

  return true;
};

export const createReminderWorker = () =>
  new Worker<QuestionnaireReminderJob>(
    QUESTIONNAIRE_REMINDERS_QUEUE,
    async (job) => {
      await sendQuestionnaireReminder(job.data.sendId);
    },
    { connection: redisConnection },
  );
