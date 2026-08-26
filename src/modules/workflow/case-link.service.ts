import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { cases, type caseRelationTypeEnum } from "../../db/schema/cases";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { recordAuditEvent } from "../shared/audit.service";
import { materializeTasksForCase } from "./task-materialization.service";

type RelationType = (typeof caseRelationTypeEnum.enumValues)[number];

/**
 * Links an existing case to a parent as a mandamus / appeal / related matter.
 *
 * The child is a real, separate `cases` row created the ordinary way before
 * this is called — a mandamus really is its own court matter with its own
 * docket, deadlines and workflow. This only establishes the relationship and
 * materializes the child's own workflow, which is why it takes two existing
 * case ids rather than creating one.
 *
 * Never automatic. Candidacy scoring (`computeMandamusCandidacy`) produces a
 * number an attorney reads; opening the sub-case off the back of it is a
 * deliberate human action, and this is the endpoint that action calls.
 */
export async function linkCase(params: {
  parentCaseId: string;
  childCaseId: string;
  relationType: RelationType;
  organizationId: string;
  actorStaffId: string | null;
}): Promise<typeof cases.$inferSelect> {
  if (params.parentCaseId === params.childCaseId) {
    throw new BadRequestError("A case cannot be linked to itself");
  }

  const scoped = (id: string) =>
    db
      .select({ id: cases.id, caseNumber: cases.caseNumber, parentCaseId: cases.parentCaseId })
      .from(cases)
      .where(and(eq(cases.id, id), eq(cases.organizationId, params.organizationId)))
      .limit(1);

  const [[parent], [child]] = await Promise.all([scoped(params.parentCaseId), scoped(params.childCaseId)]);
  if (!parent) throw new NotFoundError("Parent case not found");
  if (!child) throw new NotFoundError("Case to link not found");

  // One level only. Allowing a chain would make "the parent case" ambiguous
  // for candidacy scoring, which reads the parent's filing dates directly.
  if (parent.parentCaseId) {
    throw new BadRequestError(
      `Case ${parent.caseNumber} is itself linked to another case; link to the original matter instead.`,
    );
  }

  const [updated] = await db
    .update(cases)
    .set({ parentCaseId: params.parentCaseId, relationType: params.relationType })
    .where(eq(cases.id, params.childCaseId))
    .returning();

  await recordAuditEvent({
    action: "case.linked",
    entityType: "case",
    entityId: params.childCaseId,
    parentEntityType: "case",
    parentEntityId: params.parentCaseId,
    organizationId: params.organizationId,
    summary: `Case ${child.caseNumber} linked to ${parent.caseNumber} as ${params.relationType}`,
    metadata: { relationType: params.relationType, parentCaseId: params.parentCaseId },
    actor: params.actorStaffId ? { staffId: params.actorStaffId } : undefined,
  });

  // The child's own workflow (M1-M8 for a mandamus) only makes sense once the
  // link exists, since its steps reference the parent's chronology.
  await materializeTasksForCase(params.childCaseId);

  return updated;
}

export async function unlinkCase(params: {
  childCaseId: string;
  organizationId: string;
  actorStaffId: string | null;
}): Promise<typeof cases.$inferSelect> {
  const [child] = await db
    .select({ id: cases.id, caseNumber: cases.caseNumber, parentCaseId: cases.parentCaseId })
    .from(cases)
    .where(and(eq(cases.id, params.childCaseId), eq(cases.organizationId, params.organizationId)))
    .limit(1);

  if (!child) throw new NotFoundError("Case not found");
  if (!child.parentCaseId) throw new BadRequestError("Case is not linked to a parent");

  const [updated] = await db
    .update(cases)
    .set({ parentCaseId: null, relationType: null })
    .where(eq(cases.id, params.childCaseId))
    .returning();

  await recordAuditEvent({
    action: "case.unlinked",
    entityType: "case",
    entityId: params.childCaseId,
    parentEntityType: "case",
    parentEntityId: child.parentCaseId,
    organizationId: params.organizationId,
    summary: `Case ${child.caseNumber} unlinked from its parent`,
    metadata: { previousParentCaseId: child.parentCaseId },
    actor: params.actorStaffId ? { staffId: params.actorStaffId } : undefined,
  });

  return updated;
}
