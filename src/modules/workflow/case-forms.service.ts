import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { caseForms } from "../../db/schema/case-forms";
import { caseTypeForms } from "../../db/schema/case-type-forms";
import type { CaseFormRole, CaseFormStatus } from "../../db/schema/case-forms";
import { caseFormFieldValues } from "../../db/schema/form-fields";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import { recordAuditEvent } from "../shared/audit.service";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import {
  catalogueFieldsByForm,
  catalogueForm,
  listCatalogueForms,
} from "./form-catalogue.service";
import { readyToFileRefusal } from "./form-review.service";

const log = createModuleLogger("workflow.case-forms");

/**
 * The package a matter is filing, one row per form.
 *
 * See `db/schema/case-forms.ts` for why this replaced the single `filing_type`
 * column that used to stand in for it.
 */

/** Statuses that mean the form has reached USCIS. */
const FILED_ONWARDS: CaseFormStatus[] = [
  "filed",
  "receipted",
  "rfe",
  "approved",
  "denied",
];

/**
 * The package this matter's case type files.
 *
 * ─── Read, no longer inferred ───────────────────────────────────────────────
 *
 * This used to hold two constants — an adjustment package of six forms and a
 * naturalization package of one — and pick between them from a boolean profile
 * derived from the matter's *workflow template*. Asking the workflow was the
 * right call when the alternative was a list of case-type names in code: the
 * template already declared what kind of filing this was, and a name list
 * would have been a second source of truth.
 *
 * Now there is a first source of truth. `case_type_forms` says which forms a
 * case type files, Oravanti maintains it from the CRM, and the matter already
 * carries the `case_type_id` to look it up by. So the inference is gone with
 * the constants: a third package is a row, not a release.
 *
 * A case type with no rows gets `[]`, which is the right answer rather than a
 * failure — the matter starts with no forms and staff add what it needs.
 */
export async function defaultPackageFor(
  caseId: string,
  organizationId: string,
): Promise<{ formCode: string; role: CaseFormRole }[]> {
  const [caseRow] = await db
    .select({ caseTypeId: cases.caseTypeId })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (!caseRow) throw new NotFoundError("Case not found");

  return db
    .select({ formCode: caseTypeForms.formCode, role: caseTypeForms.role })
    .from(caseTypeForms)
    .where(eq(caseTypeForms.caseTypeId, caseRow.caseTypeId))
    .orderBy(caseTypeForms.orderIndex, caseTypeForms.formCode);
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
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      caseTypeId: cases.caseTypeId,
    })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new NotFoundError("Case not found");
  return row;
}

/** Every form on the matter, in filing order. */
export async function listCaseForms(caseId: string, organizationId: string) {
  const caseRow = await requireCase(caseId, organizationId);

  const rows = await db
    .select()
    .from(caseForms)
    .where(
      and(
        eq(caseForms.caseId, caseId),
        eq(caseForms.organizationId, organizationId),
      ),
    );

  // Sorted by the package's own filing order rather than alphabetically, with
  // anything unrecognised after it. A firm can add a form this list does not
  // know (an I-601 waiver, say) and it lands at the end rather than in the
  // middle of the package it is not part of.
  //
  // The order comes from the case type's own package, which is why this reads
  // the table rather than a constant: a matter's forms should be ranked by
  // what *its* case type files, not by what an adjustment files.
  const rank = new Map(
    (
      await db
        .select({ formCode: caseTypeForms.formCode })
        .from(caseTypeForms)
        .where(eq(caseTypeForms.caseTypeId, caseRow.caseTypeId))
        .orderBy(caseTypeForms.orderIndex, caseTypeForms.formCode)
    ).map((f, i) => [f.formCode, i] as const),
  );
  const sorted = rows.sort(
    (a, b) =>
      (rank.get(a.formCode) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.formCode) ?? Number.MAX_SAFE_INTEGER) ||
      a.formCode.localeCompare(b.formCode),
  );

  const [completion, catalogue] = await Promise.all([
    completionByForm(sorted),
    listCatalogueForms(),
  ]);
  const named = new Map(catalogue.map((f) => [f.formCode, f]));

  return sorted.map((form) => {
    const entry = named.get(form.formCode);
    return {
      ...form,
      completion: completion.get(form.id) ?? {
        populated: 0,
        total: 0,
        requiredPopulated: 0,
        requiredTotal: 0,
      },
      /**
       * The catalogue entry, so the rail can show what an I-864 *is* rather
       * than only its code. Null when nothing has named this form — a firm may
       * put a code on a matter before anybody catalogues it, and the tab shows
       * the bare code until somebody does.
       */
      definition: entry
        ? {
            id: entry.id,
            title: entry.title,
            description: entry.description,
            // The instruction, where a form is not the firm to fill. It changes
            // what the tab offers, so it travels with the definition rather
            // than being looked up again per form.
            providedBy: entry.providedBy,
          }
        : null,
    };
  });
}

/**
 * How full each form is, in one pass over the package.
 *
 * On the list rather than only on the open form, because the question somebody
 * brings to a filing package is "which of these still needs work?" — and
 * answering it by opening six forms in turn is the thing a package view exists
 * to prevent. Two queries for the whole package, not one per form.
 */
async function completionByForm(forms: { id: string; formCode: string }[]) {
  // Required is tracked separately from the total because they answer
  // different questions. "18 of 24" is progress; "every required field is in"
  // is whether the form can be filed, and that is the one the rail marks done.
  const byForm = new Map<
    string,
    {
      populated: number;
      total: number;
      requiredPopulated: number;
      requiredTotal: number;
    }
  >();
  if (forms.length === 0) return byForm;

  const fieldsByForm = await catalogueFieldsByForm(
    forms.map((f) => f.formCode),
  );

  const values = await db
    .select({
      caseFormId: caseFormFieldValues.caseFormId,
      fieldKey: caseFormFieldValues.fieldKey,
      value: caseFormFieldValues.value,
    })
    .from(caseFormFieldValues)
    .where(
      inArray(
        caseFormFieldValues.caseFormId,
        forms.map((f) => f.id),
      ),
    );

  // Keys rather than a count, because the required tally below has to ask
  // *which* fields are filled, not how many.
  const populated = new Map<string, Set<string>>();
  for (const row of values) {
    // An empty value is a row that exists, not a field that is filled — the
    // same rule `readCaseForm` applies, so the rail and the form agree.
    if (isEmptyValue(row.value)) continue;
    const keys = populated.get(row.caseFormId) ?? new Set<string>();
    keys.add(row.fieldKey);
    populated.set(row.caseFormId, keys);
  }

  for (const form of forms) {
    const fields = fieldsByForm.get(form.formCode) ?? [];
    const filled = populated.get(form.id) ?? new Set<string>();
    const required = fields.filter((field) => field.isRequired);

    byForm.set(form.id, {
      populated: filled.size,
      total: fields.length,
      requiredPopulated: required.filter((field) => filled.has(field.fieldKey))
        .length,
      requiredTotal: required.length,
    });
  }

  return byForm;
}

const isEmptyValue = (value: unknown) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

/**
 * Creates the package's rows for a matter, if they are not already there.
 *
 * Additive and idempotent, deliberately: a form already on the matter keeps
 * whatever state it has reached, and one a firm added by hand is never removed.
 * Re-running after the package definition grows adds only what is missing.
 *
 * ─── Now called automatically, and why that changed ────────────────────────
 *
 * This used to say it was deliberately never called on case creation: that the
 * package is a decision rather than a consequence of the case type, and that
 * pre-creating six rows on every immigration matter would put an I-864 on a
 * naturalization case.
 *
 * The stated risk no longer applies. `defaultPackageFor` reads
 * `case_type_forms` for the matter's own case type, so a naturalization
 * matter gets the one form its case type lists and no I-864. A case type with
 * no rows gets `[]`, which is the right answer rather than a failure.
 *
 * What survives of the objection is the weaker claim, that the package is a
 * decision at the edges — a matter may need an I-601 waiver nobody could
 * predict at creation. But this function is additive, so initializing the
 * default costs nothing that adding a form later cannot fix, and saves every
 * matter from starting blank. It now runs at the end of
 * `materializeTasksForCase`, which is where the template is already resolved.
 */
export async function ensurePackageForms(params: {
  caseId: string;
  organizationId: string;
  forms?: { formCode: string; role: CaseFormRole }[];
}): Promise<number> {
  const { caseId, organizationId } = params;
  const wanted =
    params.forms ?? (await defaultPackageFor(caseId, organizationId));

  const caseRow = await requireCase(caseId, organizationId);

  const existing = new Set(
    (
      await db
        .select({ formCode: caseForms.formCode })
        .from(caseForms)
        .where(
          and(
            eq(caseForms.caseId, caseId),
            eq(caseForms.organizationId, organizationId),
          ),
        )
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

  log.action("workflow.case_forms_initialized", {
    caseId,
    created: missing.length,
  });
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

  /*
    Ready to file is the attorney's word, not the preparer's.

    The gate is here rather than in the controller because every door onto this
    status goes through `updateCaseForm` — the Forms tab's status select, the
    batch update, and anything added later. See `form-review.service.ts` for
    what the refusal says and why approval is the only key.
  */
  if (patch.status === "ready_to_file" && existing.status !== "ready_to_file") {
    const refusal = await readyToFileRefusal(caseId);
    if (refusal) throw new ConflictError(refusal);
  }

  const next: CaseFormPatch = { ...patch };

  // A receipt number is evidence the form was receipted. Only promote from a
  // pre-filing state: a form already in `rfe`, `approved` or `denied` has moved
  // past receipt, and dragging it back would lose that.
  if (
    patch.receiptNumber &&
    !patch.status &&
    !FILED_ONWARDS.includes(existing.status)
  ) {
    next.status = "receipted";
  }

  const changed = (Object.keys(next) as (keyof CaseFormPatch)[]).filter(
    (k) =>
      next[k] !== undefined &&
      next[k] !== (existing as Record<string, unknown>)[k],
  );
  if (changed.length === 0) return existing;

  const [updated] = await db
    .update(caseForms)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(caseForms.id, existing.id))
    .returning();

  const statusChanged =
    next.status !== undefined && next.status !== existing.status;

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
      ...(statusChanged
        ? { previousStatus: existing.status, status: next.status }
        : {}),
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

  // The catalogue is deliberately untouched. It used to be possible for a
  // matter to *own* a catalogue entry — a form defined for that matter alone —
  // so removing the form had to take its definition with it. The catalogue is
  // now the platform's, identical for every firm, and taking a form out of one
  // matter's package must not remove it from the product.

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
  const outstanding = forms.filter(
    (f) => !FILED_ONWARDS.includes(f.status) && f.status !== "withdrawn",
  );

  return {
    total,
    approved,
    filed,
    percentage: total > 0 ? Math.round((approved / total) * 100) : 0,
    /** Named so the UI can say what is left rather than only how much. */
    outstanding: outstanding.map((f) => f.formCode),
  };
}

/**
 * Puts a catalogued form onto the matter.
 *
 * One write, not two. This used to name the form *and* file it in one call,
 * because a firm could author its own catalogue entry — so the alternative was
 * letting a firm name a form that appeared nowhere. The catalogue is now the
 * platform's, so there is nothing to name here: a firm chooses from the forms
 * Oravanti maintains, and choosing one that does not exist is a 404 rather
 * than an invitation to invent it.
 *
 * The workflow template already puts the standard package on a matter. This is
 * for the form that package did not anticipate — an I-765 on a matter that was
 * not going to file one — which is an ordinary thing for a firm to need and
 * has nothing to do with authoring forms.
 */
export async function addCaseForm(params: {
  caseId: string;
  organizationId: string;
  formCode: string;
  role?: CaseFormRole;
}) {
  const { caseId, organizationId, formCode } = params;
  const caseRow = await requireCase(caseId, organizationId);

  const definition = await catalogueForm(formCode);
  if (!definition) {
    throw new NotFoundError(
      `${formCode} is not a form Oravanti publishes. Ask for it to be added to the catalogue.`,
    );
  }

  const [existing] = await db
    .select({ id: caseForms.id })
    .from(caseForms)
    .where(
      and(
        eq(caseForms.caseId, caseId),
        eq(caseForms.formCode, formCode),
        eq(caseForms.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (existing) {
    throw new BadRequestError(`${formCode} is already on this matter`);
  }

  const [form] = await db
    .insert(caseForms)
    .values({
      organizationId,
      caseId,
      formCode,
      role: params.role ?? "core",
      status: "not_started",
    })
    .returning();

  await recordAuditEvent({
    action: "case.form_added",
    entityType: "case_form",
    entityId: form.id,
    parentEntityType: "case",
    parentEntityId: caseId,
    organizationId,
    summary: `${formCode} (${definition.title}) added to ${caseRow.caseNumber}`,
    metadata: { formCode, title: definition.title },
  });

  log.action(LogEvent.WORKFLOW_FORM_CATALOGUE_CHANGED, {
    caseId,
    formCode,
    change: "form_added",
  });

  return { ...form, definition };
}
