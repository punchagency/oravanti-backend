import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import {
  caseTypeDocumentRequirements,
  scenarioDocumentRequirements,
} from "../../db/schema/document-requirements";
import { NotFoundError } from "../../utils/error/app-error";
import type { DBTransaction } from "../../types/db.types";

type TemplateInsert = typeof caseTypeDocumentRequirements.$inferInsert;

/**
 * Materialize a case type's requirement templates onto a newly-opened case.
 *
 * Called from openCase inside its transaction. Idempotent — skips templates
 * already materialized onto the case (dedup by caseTypeRequirementId) — and
 * ignores archived templates. Due dates are left null: they're derived live
 * from the template's anchor/offset by the rules engine (Q3).
 */
export const materializeCaseTypeRequirements = async (
  tx: DBTransaction,
  params: { organizationId: string; caseId: string; caseTypeId: string },
): Promise<number> => {
  const templates = await tx
    .select()
    .from(caseTypeDocumentRequirements)
    .where(
      and(
        eq(caseTypeDocumentRequirements.organizationId, params.organizationId),
        eq(caseTypeDocumentRequirements.caseTypeId, params.caseTypeId),
        isNull(caseTypeDocumentRequirements.archivedAt),
      ),
    );
  if (templates.length === 0) return 0;

  const already = await tx
    .select({ ref: scenarioDocumentRequirements.caseTypeRequirementId })
    .from(scenarioDocumentRequirements)
    .where(eq(scenarioDocumentRequirements.caseId, params.caseId));
  const done = new Set(already.map((r) => r.ref).filter(Boolean));

  const rows = templates
    .filter((t) => !done.has(t.id))
    .map((t) => ({
      organizationId: params.organizationId,
      caseId: params.caseId,
      label: t.label,
      documentTypeSlug: t.documentTypeSlug,
      isRequired: t.isRequired,
      orderIndex: t.orderIndex,
      source: "template" as const,
      caseTypeRequirementId: t.id,
    }));
  if (rows.length === 0) return 0;
  await tx.insert(scenarioDocumentRequirements).values(rows);
  return rows.length;
};

export class DocumentRequirementsService {
  listByCaseType = async (organizationId: string, caseTypeId: string) =>
    db
      .select()
      .from(caseTypeDocumentRequirements)
      .where(
        and(
          eq(caseTypeDocumentRequirements.organizationId, organizationId),
          eq(caseTypeDocumentRequirements.caseTypeId, caseTypeId),
          isNull(caseTypeDocumentRequirements.archivedAt),
        ),
      )
      .orderBy(asc(caseTypeDocumentRequirements.orderIndex));

  create = async (
    organizationId: string,
    data: Omit<TemplateInsert, "organizationId">,
  ) => {
    const [row] = await db
      .insert(caseTypeDocumentRequirements)
      .values({ ...data, organizationId })
      .returning();
    return row;
  };

  update = async (
    organizationId: string,
    id: string,
    data: Partial<TemplateInsert>,
  ) => {
    const [row] = await db
      .update(caseTypeDocumentRequirements)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(caseTypeDocumentRequirements.id, id),
          eq(caseTypeDocumentRequirements.organizationId, organizationId),
        ),
      )
      .returning();
    if (!row) throw new NotFoundError("Requirement template not found");
    return row;
  };

  /** Archive (soft-delete) — retiring a template must not touch matters already
   *  materialized from it. */
  archive = async (organizationId: string, id: string) => {
    const [row] = await db
      .update(caseTypeDocumentRequirements)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(caseTypeDocumentRequirements.id, id),
          eq(caseTypeDocumentRequirements.organizationId, organizationId),
        ),
      )
      .returning({ id: caseTypeDocumentRequirements.id });
    if (!row) throw new NotFoundError("Requirement template not found");
    return { id: row.id };
  };
}
