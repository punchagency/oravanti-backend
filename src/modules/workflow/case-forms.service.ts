import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { caseForms } from "../../db/schema/case-forms";
import type { CaseFormRole, CaseFormStatus } from "../../db/schema/case-forms";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { recordAuditEvent } from "../shared/audit.service";
import { createModuleLogger } from "../../lib/logging/log";
import { caseFilingProfile } from "./case-capabilities.service";

const log = createModuleLogger("workflow.case-forms");

/**
 * The package a matter is filing, one row per form.
 *
 * See `db/schema/case-forms.ts` for why this replaced the single `filing_type`
 * column that used to stand in for it.
 */

/**
 * The forms an adjustment package is made of, and which are filings in their
 * own right.
 *
 * Four core forms plus two supporting documents, which is the distinction that
 * decides whether a receipt number is expected: USCIS issues an I-797C per core
 * form and none for the I-864 or the I-693, so showing those two with a
 * permanently empty receipt field would read as missing data rather than as the
 * normal state.
 *
 * Order is the order the package is assembled and rendered in — the I-130, the
 * filings that ride with it, then the supporting documents. It carries no
 * meaning beyond presentation: each form is adjudicated on its own clock, and
 * nothing reads this list to decide which form "represents" the matter.
 */
export const ADJUSTMENT_PACKAGE: { formCode: string; role: CaseFormRole }[] = [
  { formCode: "I-130", role: "core" },
  { formCode: "I-485", role: "core" },
  { formCode: "I-765", role: "core" },
  { formCode: "I-131", role: "core" },
  { formCode: "I-864", role: "supporting" },
  { formCode: "I-693", role: "supporting" },
];

/** A naturalization matter files one form. */
export const NATURALIZATION_PACKAGE: { formCode: string; role: CaseFormRole }[] = [
  { formCode: "N-400", role: "core" },
];

/** Statuses that mean the form has reached USCIS. */
const FILED_ONWARDS: CaseFormStatus[] = ["filed", "receipted", "rfe", "approved", "denied"];

/**
 * The package this matter's workflow implies.
 *
 * Asked of the workflow rather than of the case type, for the same reason the
 * panel's fields are (`case-capabilities.service.ts`): the template already
 * declares what kind of filing this is, and a case-type name list would be a
 * second source of truth. A matter whose workflow runs the adjustment package
 * gets the six forms; anything else gets nothing by default and names its own
 * list, because guessing wrong here puts an I-864 on a matter with no sponsor.
 */
export async function defaultPackageFor(
  caseId: string,
  organizationId: string,
): Promise<{ formCode: string; role: CaseFormRole }[]> {
  const profile = await caseFilingProfile(caseId, organizationId);
  if (profile.adjustment) return ADJUSTMENT_PACKAGE;
  if (profile.naturalization) return NATURALIZATION_PACKAGE;
  return [];
}

export type CaseFormPatch = {
  role?: CaseFormRole;
  status?: CaseFormStatus;
  editionDate?: string | null;
  filedDate?: string | null;
  receiptNumber?: string | null;
  feeCents?: number | null;
  notes?: string | null;
};

async function requireCase(caseId: string, organizationId: string) {
  const [row] = await db
    .select({ id: cases.id, caseNumber: cases.caseNumber })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Case not found");
  return row;
}

/** Every form on the matter, in filing order. */
export async function listCaseForms(caseId: string, organizationId: string) {
  await requireCase(caseId, organizationId);

  const rows = await db
    .select()
    .from(caseForms)
    .where(and(eq(caseForms.caseId, caseId), eq(caseForms.organizationId, organizationId)));

  // Sorted by the package's own filing order rather than alphabetically, with
  // anything unrecognised after it. A firm can add a form this list does not
  // know (an I-601 waiver, say) and it lands at the end rather than in the
  // middle of the package it is not part of.
  const rank = new Map(ADJUSTMENT_PACKAGE.map((f, i) => [f.formCode, i]));
  return rows.sort(
    (a, b) =>
      (rank.get(a.formCode) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.formCode) ?? Number.MAX_SAFE_INTEGER) ||
      a.formCode.localeCompare(b.formCode),
  );
}

/**
 * Creates the package's rows for a matter, if they are not already there.
 *
 * Additive and idempotent, deliberately: a form already on the matter keeps
 * whatever state it has reached, and one a firm added by hand is never removed.
 * Re-running after the package definition grows adds only what is missing.
 *
 * Not called automatically on case creation — the package a matter files is a
 * decision, not a consequence of its case type, and pre-creating six rows on
 * every immigration matter would put an I-864 on a naturalization case.
 */
export async function ensurePackageForms(params: {
  caseId: string;
  organizationId: string;
  forms?: { formCode: string; role: CaseFormRole }[];
}): Promise<number> {
  const { caseId, organizationId } = params;
  const wanted = params.forms ?? (await defaultPackageFor(caseId, organizationId));

  const caseRow = await requireCase(caseId, organizationId);

  const existing = new Set(
    (
      await db
        .select({ formCode: caseForms.formCode })
        .from(caseForms)
        .where(and(eq(caseForms.caseId, caseId), eq(caseForms.organizationId, organizationId)))
    ).map((r) => r.formCode),
  );

  const missing = wanted.filter((f) => !existing.has(f.formCode));
  if (missing.length === 0) return 0;

  await db.insert(caseForms).values(
    missing.map((f) => ({
      organizationId,
      caseId,
      formCode: f.formCode,
      role: f.role,
      status: "not_started" as const,
    })),
  );

  await recordAuditEvent({
    action: "case.forms_initialized",
    entityType: "case",
    entityId: caseId,
    parentEntityType: "case",
    parentEntityId: caseId,
    organizationId,
    summary: `Filing package set up on ${caseRow.caseNumber}: ${missing.map((f) => f.formCode).join(", ")}`,
    metadata: { formCodes: missing.map((f) => f.formCode) },
  });

  log.action("workflow.case_forms_initialized", { caseId, created: missing.length });
  return missing.length;
}

/**
 * Updates one form's standing.
 *
 * Two consistency rules are enforced here rather than left to the caller,
 * because both describe facts about USCIS rather than preferences:
 *
 *   - A receipt number means the form was receipted, so recording one moves a
 *     form that has not been marked filed into `receipted`. Leaving it in
 *     `in_preparation` with an I-797C number against it would be incoherent.
 *   - A supporting document has no receipt number of its own. USCIS issues an
 *     I-797C per core form; the I-864 and I-693 are adjudicated only as part of
 *     the filing they accompany.
 */
export async function updateCaseForm(params: {
  caseId: string;
  formCode: string;
  organizationId: string;
  patch: CaseFormPatch;
}) {
  const { caseId, formCode, organizationId, patch } = params;

  const caseRow = await requireCase(caseId, organizationId);

  const [existing] = await db
    .select()
    .from(caseForms)
    .where(
      and(
        eq(caseForms.caseId, caseId),
        eq(caseForms.formCode, formCode),
        eq(caseForms.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundError(`${formCode} is not on this matter`);

  const role = patch.role ?? existing.role;

  if (patch.receiptNumber && role === "supporting") {
    throw new BadRequestError(
      `${formCode} is a supporting document and has no receipt number of its own — ` +
        `it is adjudicated with the filing it accompanies.`,
    );
  }

  const next: CaseFormPatch = { ...patch };

  // A receipt number is evidence the form was receipted. Only promote from a
  // pre-filing state: a form already in `rfe`, `approved` or `denied` has moved
  // past receipt, and dragging it back would lose that.
  if (patch.receiptNumber && !patch.status && !FILED_ONWARDS.includes(existing.status)) {
    next.status = "receipted";
  }

  const changed = (Object.keys(next) as (keyof CaseFormPatch)[]).filter(
    (k) => next[k] !== undefined && next[k] !== (existing as Record<string, unknown>)[k],
  );
  if (changed.length === 0) return existing;

  const [updated] = await db
    .update(caseForms)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(caseForms.id, existing.id))
    .returning();

  const statusChanged = next.status !== undefined && next.status !== existing.status;

  await recordAuditEvent({
    action: statusChanged ? "case.form_status_changed" : "case.form_updated",
    entityType: "case_form",
    entityId: existing.id,
    parentEntityType: "case",
    parentEntityId: caseId,
    organizationId,
    summary: statusChanged
      ? `${formCode} on ${caseRow.caseNumber}: ${existing.status} → ${next.status}`
      : `${formCode} on ${caseRow.caseNumber} updated (${changed.join(", ")})`,
    metadata: {
      formCode,
      changed,
      ...(statusChanged ? { previousStatus: existing.status, status: next.status } : {}),
    },
  });

  return updated;
}

/** Removes a form from the matter. Only before it has reached USCIS. */
export async function removeCaseForm(params: {
  caseId: string;
  formCode: string;
  organizationId: string;
}) {
  const { caseId, formCode, organizationId } = params;
  const caseRow = await requireCase(caseId, organizationId);

  const [existing] = await db
    .select()
    .from(caseForms)
    .where(
      and(
        eq(caseForms.caseId, caseId),
        eq(caseForms.formCode, formCode),
        eq(caseForms.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundError(`${formCode} is not on this matter`);

  // A filed form is part of the record of what was sent to the government.
  // Withdrawing it is a status, not a deletion — same reasoning as a withdrawn
  // workflow task.
  if (FILED_ONWARDS.includes(existing.status)) {
    throw new BadRequestError(
      `${formCode} has already been filed. Set its status to "withdrawn" rather than removing it, ` +
        `so the record of what was sent to USCIS survives.`,
    );
  }

  await db.delete(caseForms).where(eq(caseForms.id, existing.id));

  await recordAuditEvent({
    action: "case.form_removed",
    entityType: "case_form",
    entityId: existing.id,
    parentEntityType: "case",
    parentEntityId: caseId,
    organizationId,
    summary: `${formCode} removed from ${caseRow.caseNumber} before filing`,
    metadata: { formCode, previousStatus: existing.status },
  });
}

/**
 * How far the package has got, as a figure the UI can show without re-deriving
 * it.
 *
 * "Complete" means approved. A filed form is progress, not completion — the
 * whole point of tracking per form is that an I-765 approved months before the
 * I-485 it rides with is visible as such.
 */
export async function packageProgress(caseId: string, organizationId: string) {
  const forms = await listCaseForms(caseId, organizationId);

  const total = forms.length;
  const approved = forms.filter((f) => f.status === "approved").length;
  const filed = forms.filter((f) => FILED_ONWARDS.includes(f.status)).length;
  const outstanding = forms.filter((f) => !FILED_ONWARDS.includes(f.status) && f.status !== "withdrawn");

  return {
    total,
    approved,
    filed,
    percentage: total > 0 ? Math.round((approved / total) * 100) : 0,
    /** Named so the UI can say what is left rather than only how much. */
    outstanding: outstanding.map((f) => f.formCode),
  };
}

