import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { workflowModules, workflowTemplateSteps } from "../../db/schema/workflow";
import type { Condition, ConditionField } from "../../db/schema/workflow";
import { NotFoundError } from "../../utils/error/app-error";
import { resolveWorkflowTemplateId } from "./workflow-template.service";

/**
 * What a case's workflow actually does, asked of the workflow itself.
 *
 * The pre-filing checks and the fee quote are both adjustment-specific — the
 * rules are the I-485 package's rules and the quote is for I-130/I-485/I-765/
 * I-131 — but the endpoints serving them took a case id and asked nothing else.
 * An N-400 hitting `/filing-fees` got a quote for four forms it will never
 * file, and `/pitfalls` ran the affidavit-of-support and medical-exam rules
 * against a matter that has neither.
 *
 * Practice area is no help here: Immigration has ~90 case types and three of
 * them have a workflow at all. The case type is the right granularity, but a
 * name list is a second source of truth that goes stale when a template
 * changes. So the template answers, exactly as it does on the front end
 * (`case-type-fields.ts`) — the same two condition fields, derived the same
 * way, because it is the same question.
 */

/** How the seeded templates gate the I-485 package. */
const ADJUSTMENT_TRIGGERS: ConditionField[] = [
  "immigrationDetails.filingTrack",
  "immigrationDetails.priorityDateIsCurrent",
];

/**
 * Every field a condition consults, flattened through `allOf` / `anyOf`.
 *
 * The AOS gate is an `anyOf` of two leaves, so reading `.field` off the top
 * level would return nothing for the one condition that matters most.
 */
export function fieldsReferencedBy(condition: Condition | null | undefined): ConditionField[] {
  if (!condition) return [];
  if ("allOf" in condition) return condition.allOf.flatMap(fieldsReferencedBy);
  if ("anyOf" in condition) return condition.anyOf.flatMap(fieldsReferencedBy);
  return [condition.field];
}

/**
 * What kind of filing this case's workflow describes.
 *
 * Mirrors `case-type-fields.ts` on the front end — same signals, same reasoning
 * — because it is the same question asked from the other side. The front end
 * uses it to decide which fields to show; the server uses it to decide which
 * endpoints apply and which forms a package is made of.
 *
 * Conditions alone are not enough, and the N-400 is why: every one of its
 * modules is unconditional, so a rule reading only activation conditions would
 * see nothing at all. What distinguishes it is what its steps count *from* —
 * `oath_ceremony_date`, which no other template anchors on.
 *
 * Every flag is false for a case type with no template. A workflow that does
 * not exist cannot be said to file anything.
 */
export interface CaseFilingProfile {
  adjustment: boolean;
  naturalization: boolean;
  mandamus: boolean;
}

/** Anchors unique to one kind of workflow. See the FE's `GROUP_SIGNALS`. */
const NATURALIZATION_ANCHORS = ["oath_ceremony_date"];
const MANDAMUS_ANCHORS = ["service_completed_date", "ruling_date"];

export async function caseFilingProfile(
  caseId: string,
  organizationId: string,
): Promise<CaseFilingProfile> {
  const none = { adjustment: false, naturalization: false, mandamus: false };

  const [caseRow] = await db
    .select({ caseTypeId: cases.caseTypeId })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (!caseRow) throw new NotFoundError("Case not found");

  const templateId = await resolveWorkflowTemplateId(organizationId, caseRow.caseTypeId);
  if (!templateId) return none;

  const modules = await db
    .select({ id: workflowModules.id, activationCondition: workflowModules.activationCondition })
    .from(workflowModules)
    .where(eq(workflowModules.templateId, templateId));
  if (modules.length === 0) return none;

  const steps = await db
    .select({ dueDateAnchor: workflowTemplateSteps.dueDateAnchor })
    .from(workflowTemplateSteps)
    .where(inArray(workflowTemplateSteps.moduleId, modules.map((m) => m.id)));

  const fields = new Set(modules.flatMap((m) => fieldsReferencedBy(m.activationCondition)));
  const anchors = new Set(steps.map((s) => s.dueDateAnchor).filter(Boolean) as string[]);

  return {
    adjustment: ADJUSTMENT_TRIGGERS.some((f) => fields.has(f)),
    naturalization:
      fields.has("immigrationDetails.naturalizationTrack") ||
      NATURALIZATION_ANCHORS.some((a) => anchors.has(a)),
    mandamus: MANDAMUS_ANCHORS.some((a) => anchors.has(a)),
  };
}

/** Does this case's workflow assemble the adjustment-of-status package? */
export async function caseRunsAdjustmentPackage(
  caseId: string,
  organizationId: string,
): Promise<boolean> {
  return (await caseFilingProfile(caseId, organizationId)).adjustment;
}

/**
 * Refuses a request for something this case's workflow does not do.
 *
 * A 404 rather than a 403: the caller is not forbidden from seeing the AOS
 * checks, there are simply no AOS checks on a matter that files no I-485. The
 * message names the reason so the response is diagnosable on its own.
 */
export async function requireAdjustmentPackage(
  caseId: string,
  organizationId: string,
): Promise<void> {
  if (await caseRunsAdjustmentPackage(caseId, organizationId)) return;
  throw new NotFoundError(
    "This case's workflow does not file an adjustment-of-status package, " +
      "so it has no I-485 pre-filing checks or package fee quote.",
  );
}

