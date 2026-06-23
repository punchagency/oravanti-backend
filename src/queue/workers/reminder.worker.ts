import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { leads } from "../../db/schema/leads";
import {
  questionnaireResponses,
  questionnaireSends,
} from "../../db/schema/questionnaires";
import { emailService } from "../../utils/email/email.service";
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

  const baseUrl =
    process.env.APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3000";

  emailService
    .sendEmail({
      to: lead.email,
      subject: "Reminder: please complete your intake questionnaire",
      html: `<p>Dear ${lead.name},</p>
        <p>This is a friendly reminder to complete your intake questionnaire.</p>
        <p>If you have misplaced your link, please contact your attorney's office.</p>`,
    })
    .catch(console.error);

  // SMS delivery is stubbed until a provider is wired.
  const channels = (send.deliveryChannels as string[] | null) ?? [];
  if (channels.includes("sms") && lead.phone) {
    console.log(`[sms-stub] reminder to ${lead.phone} for send ${sendId}`);
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
    async (job) => {
      await sendQuestionnaireReminder(job.data.sendId);
    },
    { connection: redisConnection },
  );
