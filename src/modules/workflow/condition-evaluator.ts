import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import type { Condition, ConditionField } from "../../db/schema/workflow";
import { immigrationCaseDetails } from "../../db/schema/immigration-case-details";
import { personalInjuryCaseDetails } from "../../db/schema/personal-injury-case-details";

/**
 * The context a `Condition` is evaluated against — a case row plus whichever of
 * the two practice-area extension tables applies. Assembled once per
 * materialization pass, not per condition, since several modules on the same
 * template may each carry one.
 */
export type ConditionContext = {
  case: { priority: string };
  immigrationDetails: {
    filingTrack: string | null;
    naturalizationTrack: string | null;
    isConditionalResidence: boolean;
    priorityDateIsCurrent: boolean;
  } | null;
  personalInjuryDetails: {
    defendantType: string;
    isMinorPlaintiff: boolean;
  } | null;
};

export async function buildConditionContext(
  caseId: string,
  organizationId: string,
): Promise<ConditionContext> {
  const [caseRow] = await db
    .select({ priority: cases.priority })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);

  const [immigration] = await db
    .select({
      filingTrack: immigrationCaseDetails.filingTrack,
      naturalizationTrack: immigrationCaseDetails.naturalizationTrack,
      isConditionalResidence: immigrationCaseDetails.isConditionalResidence,
      priorityDateIsCurrent: immigrationCaseDetails.priorityDateIsCurrent,
    })
    .from(immigrationCaseDetails)
    .where(eq(immigrationCaseDetails.caseId, caseId))
    .limit(1);

  const [personalInjury] = await db
    .select({
      defendantType: personalInjuryCaseDetails.defendantType,
      isMinorPlaintiff: personalInjuryCaseDetails.isMinorPlaintiff,
    })
    .from(personalInjuryCaseDetails)
    .where(eq(personalInjuryCaseDetails.caseId, caseId))
    .limit(1);

  return {
    case: { priority: caseRow?.priority ?? "medium" },
    immigrationDetails: immigration ?? null,
    personalInjuryDetails: personalInjury ?? null,
  };
}

/**
 * Only resolves the closed `ConditionField` union — no arbitrary path
 * traversal, so a bad template can't reference a field that doesn't exist and
 * silently always-false. `activationCondition` is also validated against this
 * same union at template-save time (see workflow-template.service.ts); this is
 * the runtime half of that guarantee.
 */
function getFieldValue(field: ConditionField, ctx: ConditionContext): unknown {
  switch (field) {
    case "immigrationDetails.filingTrack":
      return ctx.immigrationDetails?.filingTrack ?? null;
    case "immigrationDetails.naturalizationTrack":
      return ctx.immigrationDetails?.naturalizationTrack ?? null;
    case "immigrationDetails.isConditionalResidence":
      return ctx.immigrationDetails?.isConditionalResidence ?? false;
    case "immigrationDetails.priorityDateIsCurrent":
      return ctx.immigrationDetails?.priorityDateIsCurrent ?? false;
    case "personalInjuryDetails.defendantType":
      return ctx.personalInjuryDetails?.defendantType ?? null;
    case "personalInjuryDetails.isMinorPlaintiff":
      return ctx.personalInjuryDetails?.isMinorPlaintiff ?? false;
    case "case.priority":
      return ctx.case.priority;
  }
}

export function evaluateCondition(condition: Condition, ctx: ConditionContext): boolean {
  if ("allOf" in condition) return condition.allOf.every((c) => evaluateCondition(c, ctx));
  if ("anyOf" in condition) return condition.anyOf.some((c) => evaluateCondition(c, ctx));

  const actual = getFieldValue(condition.field, ctx);
  switch (condition.op) {
    case "eq":
      return actual === condition.value;
    case "neq":
      return actual !== condition.value;
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(actual as string);
  }
}

/**
 * Whether any field the condition reads has no answer yet.
 *
 * `evaluateCondition` cannot tell "false" from "nobody has said" — both make a
 * module inactive, which is right for *activating* it but wrong for
 * *withdrawing* one. A matter recorded as `concurrent` materializes the I-485
 * package; clearing the track to re-pick it would then read as a decision that
 * the package no longer applies and cancel twenty open tasks, when all that
 * happened is a half-finished edit.
 *
 * So withdrawal asks this first and holds when the answer is yes. Activation
 * does not — an unanswered field is not grounds to start work either, it is
 * only grounds not to destroy work already started.
 *
 * Only genuinely nullable columns can be unanswered. The booleans are
 * `NOT NULL DEFAULT false`, so they read as a decided "no" from the moment the
 * row exists — which is correct for them: `isConditionalResidence` false means
 * the I-751 module never activated, so there is nothing to withdraw, and
 * un-ticking it is a person positively deciding the matter is not conditional.
 */
export function conditionHasUnansweredInput(
  condition: Condition,
  ctx: ConditionContext,
): boolean {
  return fieldsReferencedBy(condition).some((field) => getFieldValue(field, ctx) === null);
}

/** Recursively walks a `Condition`, collecting every field it references — used to validate a template's `activationCondition` at save time. */
export function fieldsReferencedBy(condition: Condition): ConditionField[] {
  if ("allOf" in condition) return condition.allOf.flatMap(fieldsReferencedBy);
  if ("anyOf" in condition) return condition.anyOf.flatMap(fieldsReferencedBy);
  return [condition.field];
}
