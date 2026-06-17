import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { firmPracticeAreas } from "../../db/schema/firm-practice-areas";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../db/schema/practice-area-subcategories";
import { practiceAreas } from "../../db/schema/practice-areas";
import {
  SubscriptionStatus,
  subscriptions,
} from "../../db/schema/subscriptions";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

export const normalizePracticeAreaName = (name: string) => name.trim();

export const ensurePracticeAreaExists = async (
  organizationId: string,
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
        eq(firmPracticeAreas.organizationId, organizationId),
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

export const ensureCaseTypeBelongsToPracticeArea = async (
  organizationId: string,
  practiceAreaId?: string,
  caseType?: string,
) => {
  const practiceArea = await ensurePracticeAreaExists(organizationId, practiceAreaId);

  if (!caseType?.trim()) {
    throw new BadRequestError("caseType is required");
  }

  const [practiceAreaCaseType] = await db
    .select({
      id: practiceAreaCaseTypes.id,
      subcategoryId: practiceAreaCaseTypes.subcategoryId,
      code: practiceAreaCaseTypes.code,
      name: practiceAreaCaseTypes.name,
      caseNumberPrefix: practiceAreaCaseTypes.caseNumberPrefix,
      jurisdiction: practiceAreaCaseTypes.jurisdiction,
    })
    .from(practiceAreaCaseTypes)
    .innerJoin(
      practiceAreaSubcategories,
      eq(practiceAreaSubcategories.id, practiceAreaCaseTypes.subcategoryId),
    )
    .where(
      and(
        eq(practiceAreaSubcategories.practiceAreaId, practiceArea.id),
        eq(practiceAreaCaseTypes.code, caseType.trim()),
      ),
    );

  if (!practiceAreaCaseType) {
    throw new BadRequestError(
      "caseType does not belong to the selected practice area",
    );
  }

  return {
    practiceArea,
    caseType: practiceAreaCaseType,
  };
};
