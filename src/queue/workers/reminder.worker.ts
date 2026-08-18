import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { leads } from "../../db/schema/leads";
import {
  questionnaireResponses,
  questionnaireSends,
} from "../../db/schema/questionnaires";
import { emailService } from "../../utils/email/email.service";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import { runWithRequestContext } from "../../middleware/request-context";
import { redisConnection } from "../connection";
import {
  QUESTIONNAIRE_REMINDERS_QUEUE,
  type QuestionnaireReminderJob,
} from "../queues";

const log = createModuleLogger("reminder.worker");

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

  const baseUrl =
    process.env.APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000";

  emailService
    .sendEmail({
      to: lead.email,
      subject: "Reminder: please complete your intake questionnaire",
      html: `<p>Dear ${lead.firstName},</p>
        <p>This is a friendly reminder to complete your intake questionnaire.</p>
        <p>If you have misplaced your link, please contact your attorney's office.</p>`,
    })
    .catch((err) => log.failure(LogEvent.QUESTIONNAIRE_REMINDER_FAILED, err, { sendId }));

  // SMS delivery is stubbed until a provider is wired.
  const channels = (send.deliveryChannels as string[] | null) ?? [];
  if (channels.includes("sms") && lead.phone) {
    log.info(LogEvent.SMS_FOLLOWUP_STUB, { sendId, phone: lead.phone });
  }

  await db
    .update(questionnaireSends)
    .set({ lastReminderAt: new Date(), updatedAt: new Date() })
    .where(eq(questionnaireSends.id, sendId));

  void baseUrl;
  return true;
};

export const createReminderWorker = () =>
  new Worker<QuestionnaireReminderJob>(
    QUESTIONNAIRE_REMINDERS_QUEUE,
    async (job) =>
      /*
        Re-enter a request context inside the worker.

        Without this the job runs with no store, every logger falls back to the
        process-wide id, and any audit row it writes has a null actor and a
        null IP. Reusing the enqueuing request's id means the reminder that
        went out on Tuesday is still traceable to the Friday request that
        scheduled it; a job with no origin gets a fresh id rather than none.
      */
      runWithRequestContext(
        {
          source: "queue",
          ...(job.data.requestId ? { requestId: job.data.requestId } : {}),
        },
        async () => {
          await sendQuestionnaireReminder(job.data.sendId);
        },
      ),
    { connection: redisConnection },
  );
