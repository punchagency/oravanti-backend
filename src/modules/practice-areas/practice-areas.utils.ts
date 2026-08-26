import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../db/schema/practice-area-subcategories";
import { practiceAreas } from "../../db/schema/practice-areas";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

export const normalizePracticeAreaName = (name: string) => name.trim();

export const ensurePracticeAreaExists = async (
  _organizationId: string,
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

  /**
   * TODO: Subscription check is temporarily disabled until we have a proper subscription management system in place.
   */

  //   // Subscription check skipped in development — subscriptions aren't seeded
  //   if (env.isProduction) {
  //     const [subscription] = await db
  //       .select({ id: subscriptions.id })
  //       .from(firmPracticeAreas)
  //       .innerJoin(subscriptions, eq(subscriptions.id, firmPracticeAreas.subscriptionId))
  //       .where(
  //         and(
  //           eq(firmPracticeAreas.organizationId, organizationId),
  //           eq(firmPracticeAreas.practiceAreaId, practiceAreaId),
  //           eq(firmPracticeAreas.active, true),
  //           eq(subscriptions.status, SubscriptionStatus.ACTIVE),
  //         ),
  //       );
  //
  //     if (!subscription) {
  //       throw new BadRequestError("Firm is not subscribed to this practice area");
  //     }
  //   }

  return practiceArea;
};

/**
 * The same question as `ensureCaseTypeBelongsToPracticeArea`, asked by id.
 *
 * That one keys on `practiceAreaCaseTypes.code`, which suits the cases module —
 * it receives a code from the caller. Leads carry a uuid on both columns, so
 * they need this shape instead. Kept beside its twin rather than in the leads
 * module so the two cannot drift apart.
 *
 * Worth being explicit about why an id lookup is not enough on its own: a case
 * type reaches its practice area only through its subcategory
 * (`practice_area_case_types.subcategory_id -> practice_area_subcategories
 * .practice_area_id`), so `leads.practice_area_id` and `leads.case_type_id` are
 * two independent foreign keys that are each individually satisfiable while
 * describing different practice areas. Nothing in the database can object.
 *
 * What that costs at case opening, where the pair is finally read together:
 * `code` is unique only per SUBCATEGORY, so the same code legitimately exists
 * under several practice areas. If the lead's area has no case type with that
 * code, `generateCaseNumber` throws — at the last pipeline stage, after the
 * consultation fee is paid and the agreement signed, about a field set at
 * intake. If it does have one, nothing throws at all: the case number is
 * stamped with THAT area's prefix while `cases.case_type_id` keeps the
 * original id, and the file is numbered as one case type and typed as another.
 */
export const ensureCaseTypeIdBelongsToPracticeArea = async (
  practiceAreaId: string,
  caseTypeId: string,
) => {
  const [row] = await db
    .select({ id: practiceAreaCaseTypes.id })
    .from(practiceAreaCaseTypes)
    .innerJoin(
      practiceAreaSubcategories,
      eq(practiceAreaSubcategories.id, practiceAreaCaseTypes.subcategoryId),
    )
    .where(
      and(
        eq(practiceAreaCaseTypes.id, caseTypeId),
        eq(practiceAreaSubcategories.practiceAreaId, practiceAreaId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new BadRequestError(
      "The selected case type does not belong to the selected practice area",
    );
  }

  return row;
};

export const ensureCaseTypeBelongsToPracticeArea = async (
  organizationId: string,
  practiceAreaId?: string,
  caseType?: string,
) => {
  const practiceArea = await ensurePracticeAreaExists(
    organizationId,
    practiceAreaId,
  );

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
