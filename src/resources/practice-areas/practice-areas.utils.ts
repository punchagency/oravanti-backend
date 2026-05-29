import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { firmPracticeAreas } from "../../db/schema/firm-practice-areas";
import { practiceAreas } from "../../db/schema/practice-areas";
import {
  SubscriptionStatus,
  subscriptions,
} from "../../db/schema/subscriptions";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

export const normalizePracticeAreaName = (name: string) => name.trim();

export const ensurePracticeAreaExists = async (
  firmId: string,
  practiceAreaId?: string,
) => {
  if (!practiceAreaId) {
    throw new BadRequestError("practiceAreaId is required");
  }

  const [practiceArea] = await db
    .select({ id: practiceAreas.id })
    .from(practiceAreas)
    .where(eq(practiceAreas.id, practiceAreaId));

  if (!practiceArea) {
    throw new NotFoundError("Practice area not found");
  }

  const [subscription] = await db
    .select({ id: subscriptions.id })
    .from(firmPracticeAreas)
    .innerJoin(subscriptions, eq(subscriptions.id, firmPracticeAreas.subscriptionId))
    .where(
      and(
        eq(firmPracticeAreas.firmId, firmId),
        eq(firmPracticeAreas.practiceAreaId, practiceAreaId),
        eq(firmPracticeAreas.active, true),
        eq(subscriptions.status, SubscriptionStatus.ACTIVE),
      ),
    );

  if (!subscription) {
    throw new BadRequestError("Firm is not subscribed to this practice area");
  }

  return practiceArea;
};
