import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { withTransaction } from "../../db/transaction-context";
import { caseForms } from "../../db/schema/case-forms";
import {
  caseFormFieldRevisions,
  caseFormFieldValues,
  caseFormVersions,
} from "../../db/schema/form-fields";
import type {
  CaseFormVersionActor,
  FormFieldValueSource,
} from "../../db/schema/form-fields";
import { staff } from "../../db/schema/staff";
import { NotFoundError } from "../../utils/error/app-error";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import { catalogueFields } from "./form-catalogue.service";

const log = createModuleLogger("workflow.form_history");

type JsonObject = Record<string, unknown>;

/**
 * One field, as the caller wants it to end up.
 *
 * The whole row rather than only the value, because the two writers disagree
 * about everything except the value: a staff edit sets `isManualOverride` and a
 * population run clears it, and each has its own idea of what `sourceValue`
 * should say. Passing the intended end state means this file does not have to
 * know which caller it is serving.
 */
export type FormFieldWrite = {
  fieldKey: string;
  value: unknown;
  valueSource: FormFieldValueSource;
  isManualOverride?: boolean;
  /**
   * What the questionnaire says, kept beside a hand edit so the two compare.
   *
   * `undefined` leaves whatever is stored alone — which is what an ordinary
   * population write wants, since it has nothing to disagree with. Pass `null`
   * to clear it.
   */
  sourceValue?: unknown;
  sourceQuestionId?: string | null;
};

/**
 * The one place a form field value is ever written.
 *
 * A staff member saving the Forms tab and a population run carrying answers
 * across are the same operation seen from two sides, and the history is only
 * complete if both come through here — a version exists because a save
 * happened, not because somebody remembered to record one. Same reasoning, and
 * the same shape, as `commitAnswers` in the questionnaire module.
 *
 * A save does three things, in this order:
 *
 *   1. Diffs against what is stored. A write that changes nothing is dropped,
 *      so "4 fields changed" means four. A write that changes only *provenance*
 *      — the questionnaire moved on but a hand edit stands — is applied but not
 *      counted, because the form still says what it said.
 *   2. Applies what is left.
 *   3. Writes one version (the whole form, so restore is a read) and one
 *      revision per changed field (so one box has a timeline).
 *
 * Returns `version: null` when nothing changed, which callers use to decide
 * whether anything is worth telling the user about.
 */
export async function commitFormValues(params: {
  organizationId: string;
  caseFormId: string;
  writes: FormFieldWrite[];
  actor: CaseFormVersionActor;
  /**
   * The staff member behind the save.
   *
   * Credited on the *rows* either way — somebody pressed the button — but on
   * the version only when `actor` is `staff`. A population run is attributed to
   * the questionnaire, because that is what decided the values.
   */
  actorId?: string;
  /** Set when this save is itself a restore. */
  restoredFromVersionId?: string | null;
}) {
  const { organizationId, caseFormId, writes, actor, actorId, restoredFromVersionId } =
    params;

  return withTransaction(db, async () => {
    const stored = await db
      .select()
      .from(caseFormFieldValues)
      .where(eq(caseFormFieldValues.caseFormId, caseFormId));

    const current = new Map(stored.map((row) => [row.fieldKey, row]));

    // An emptied field is a deletion, not a stored null: `readCaseForm` counts
    // rows to say how full a form is, and a row holding null would count as
    // populated. Same rule the questionnaire applies to an emptied answer.
    const applied: (FormFieldWrite & { sourceValue: unknown })[] = [];
    const changes: {
      fieldKey: string;
      previousValue: unknown;
      value: unknown;
      previousSource: FormFieldValueSource | null;
      source: FormFieldValueSource | null;
    }[] = [];

    for (const write of writes) {
      const next = isEmpty(write.value) ? null : write.value;
      const row = current.get(write.fieldKey);
      const previous = row ? row.value : null;

      const manual = write.isManualOverride ?? false;
      const sourceValue =
        write.sourceValue === undefined
          ? (row?.sourceValue ?? null)
          : (write.sourceValue ?? null);

      const valueChanged = !sameValue(previous, next);
      const provenanceChanged =
        row !== undefined &&
        (row.isManualOverride !== manual || !sameValue(row.sourceValue, sourceValue));

      if (!valueChanged && !provenanceChanged) continue;

      applied.push({ ...write, value: next, isManualOverride: manual, sourceValue });

      if (!valueChanged) continue;
      changes.push({
        fieldKey: write.fieldKey,
        previousValue: previous,
        value: next,
        previousSource: row?.valueSource ?? null,
        source: next === null ? null : write.valueSource,
      });
    }

    if (applied.length === 0) {
      return { changed: 0, version: null, values: stored };
    }

    const now = new Date();

    for (const write of applied) {
      if (write.value === null) {
        await db
          .delete(caseFormFieldValues)
          .where(
            and(
              eq(caseFormFieldValues.caseFormId, caseFormId),
              eq(caseFormFieldValues.fieldKey, write.fieldKey),
            ),
          );
        current.delete(write.fieldKey);
        continue;
      }

      const [saved] = await db
        .insert(caseFormFieldValues)
        .values({
          organizationId,
          caseFormId,
          fieldKey: write.fieldKey,
          value: write.value as JsonObject,
          valueSource: write.valueSource,
          isManualOverride: write.isManualOverride,
          sourceValue: write.sourceValue as JsonObject | null,
          sourceQuestionId: write.sourceQuestionId ?? null,
          updatedById: actorId,
        })
        .onConflictDoUpdate({
          target: [caseFormFieldValues.caseFormId, caseFormFieldValues.fieldKey],
          set: {
            value: write.value as JsonObject,
            valueSource: write.valueSource,
            isManualOverride: write.isManualOverride,
            sourceValue: write.sourceValue as JsonObject | null,
            sourceQuestionId: write.sourceQuestionId ?? null,
            updatedById: actorId,
            updatedAt: now,
          },
        })
        .returning();
      current.set(write.fieldKey, saved);
    }

    if (changes.length === 0) {
      // Provenance moved and the form did not. Worth storing — that is how a
      // disagreement between a hand edit and the questionnaire becomes visible
      // — but not worth a version, which would read as a save that changed
      // nothing.
      return { changed: 0, version: null, values: [...current.values()] };
    }

    // Numbered per form so staff can say "version 4 of the I-485" and mean
    // something. Read inside the transaction, so two concurrent saves cannot
    // both claim the same number — the unique index would reject the second
    // anyway, and this is what stops it getting there.
    const [{ highest }] = await db
      .select({
        highest: sql<number>`coalesce(max(${caseFormVersions.versionNumber}), 0)`,
      })
      .from(caseFormVersions)
      .where(eq(caseFormVersions.caseFormId, caseFormId));

    const [version] = await db
      .insert(caseFormVersions)
      .values({
        organizationId,
        caseFormId,
        versionNumber: Number(highest) + 1,
        actor,
        savedById: actor === "staff" ? actorId : undefined,
        values: Object.fromEntries(
          [...current.values()].map((row) => [row.fieldKey, row.value]),
        ) as JsonObject,
        changedCount: changes.length,
        restoredFromVersionId: restoredFromVersionId ?? null,
      })
      .returning();

    await db.insert(caseFormFieldRevisions).values(
      changes.map((change) => ({
        organizationId,
        caseFormId,
        versionId: version.id,
        fieldKey: change.fieldKey,
        previousValue: change.previousValue as JsonObject | null,
        value: change.value as JsonObject | null,
        previousSource: change.previousSource,
        source: change.source,
        actor,
        changedById: actor === "staff" ? actorId : undefined,
      })),
    );

    log.action(LogEvent.WORKFLOW_FORM_VALUES_SAVED, {
      caseFormId,
      versionNumber: version.versionNumber,
      changed: changes.length,
      actor,
    });

    return { changed: changes.length, version, values: [...current.values()] };
  });
}

/**
 * The saves made against one form, newest first.
 *
 * The snapshot is deliberately not returned — one blob per row, and the list
 * only needs to say who saved what and when. `getFormVersion` fetches one.
 */
export async function listFormVersions(
  organizationId: string,
  caseFormId: string,
) {
  const rows = await db
    .select({
      id: caseFormVersions.id,
      versionNumber: caseFormVersions.versionNumber,
      actor: caseFormVersions.actor,
      changedCount: caseFormVersions.changedCount,
      restoredFromVersionId: caseFormVersions.restoredFromVersionId,
      createdAt: caseFormVersions.createdAt,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(caseFormVersions)
    .leftJoin(staff, eq(staff.id, caseFormVersions.savedById))
    .where(
      and(
        eq(caseFormVersions.caseFormId, caseFormId),
        eq(caseFormVersions.organizationId, organizationId),
      ),
    )
    .orderBy(desc(caseFormVersions.versionNumber));

  return rows.map(({ firstName, lastName, ...row }) => ({
    ...row,
    savedBy: fullName(firstName, lastName),
  }));
}

/**
 * Who to credit a save to.
 *
 * A population run has no staff row behind it, so the name is null and the
 * caller shows "the questionnaire" instead — which is the fact that matters
 * anyway.
 */
function fullName(first: string | null, last: string | null) {
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}

/** One version, with the fields it changed named as the form names them. */
export async function getFormVersion(organizationId: string, versionId: string) {
  const [version] = await db
    .select()
    .from(caseFormVersions)
    .where(
      and(
        eq(caseFormVersions.id, versionId),
        eq(caseFormVersions.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!version) throw new NotFoundError("Version not found");

  const [form] = await db
    .select({ formCode: caseForms.formCode, caseId: caseForms.caseId })
    .from(caseForms)
    .where(eq(caseForms.id, version.caseFormId))
    .limit(1);

  const [revisions, fields] = await Promise.all([
    db
      .select({
        fieldKey: caseFormFieldRevisions.fieldKey,
        previousValue: caseFormFieldRevisions.previousValue,
        value: caseFormFieldRevisions.value,
        previousSource: caseFormFieldRevisions.previousSource,
        source: caseFormFieldRevisions.source,
      })
      .from(caseFormFieldRevisions)
      .where(eq(caseFormFieldRevisions.versionId, versionId)),
    form ? catalogueFields(form.formCode) : Promise.resolve([]),
  ]);

  const labels = new Map(fields.map((f) => [f.fieldKey, f.label]));

  return {
    ...version,
    formCode: form?.formCode ?? null,
    // Falls back to the key, because a field dropped from the catalogue still
    // has a history and showing a blank label would hide it.
    changes: revisions.map((r) => ({ ...r, label: labels.get(r.fieldKey) ?? r.fieldKey })),
  };
}

/**
 * One field's timeline, newest first.
 *
 * Scoped by form as well as key, so a key that appears on six forms of a
 * package — every name and date does — shows only this form's history.
 */
export async function listFieldRevisions(
  organizationId: string,
  caseFormId: string,
  fieldKey: string,
) {
  const rows = await db
    .select({
      id: caseFormFieldRevisions.id,
      previousValue: caseFormFieldRevisions.previousValue,
      value: caseFormFieldRevisions.value,
      previousSource: caseFormFieldRevisions.previousSource,
      source: caseFormFieldRevisions.source,
      actor: caseFormFieldRevisions.actor,
      createdAt: caseFormFieldRevisions.createdAt,
      versionNumber: caseFormVersions.versionNumber,
      firstName: staff.firstName,
      lastName: staff.lastName,
    })
    .from(caseFormFieldRevisions)
    .innerJoin(
      caseFormVersions,
      eq(caseFormVersions.id, caseFormFieldRevisions.versionId),
    )
    .leftJoin(staff, eq(staff.id, caseFormFieldRevisions.changedById))
    .where(
      and(
        eq(caseFormFieldRevisions.caseFormId, caseFormId),
        eq(caseFormFieldRevisions.fieldKey, fieldKey),
        eq(caseFormFieldRevisions.organizationId, organizationId),
      ),
    )
    .orderBy(desc(caseFormFieldRevisions.createdAt));

  return rows.map(({ firstName, lastName, ...row }) => ({
    ...row,
    changedBy: fullName(firstName, lastName),
  }));
}

/**
 * Puts a form back to an earlier version — forward, as a new version.
 *
 * Nothing after the restored version is erased, which is the property that
 * makes restoring safe to try: the state you left is still version N and the
 * restore is version N+1. Same rule the questionnaire's restore follows.
 *
 * Fields the catalogue has since dropped are left out. Writing them back would
 * store values the form cannot print and nobody can correct.
 */
export async function restoreFormVersion(params: {
  organizationId: string;
  versionId: string;
  actorId?: string;
}) {
  const { organizationId, versionId, actorId } = params;
  const version = await getFormVersion(organizationId, versionId);

  const [form] = await db
    .select({ id: caseForms.id, formCode: caseForms.formCode, caseId: caseForms.caseId })
    .from(caseForms)
    .where(eq(caseForms.id, version.caseFormId))
    .limit(1);
  if (!form) throw new NotFoundError("Form not found");

  const snapshot = version.values as Record<string, unknown>;
  const live = await catalogueFields(form.formCode);

  // Every live field, not only the ones the snapshot names: a field added after
  // the version was saved has to be *cleared*, or the restore leaves the form
  // holding a mix of two moments.
  const writes: FormFieldWrite[] = live.map((field) => ({
    fieldKey: field.fieldKey,
    value: snapshot[field.fieldKey] ?? null,
    // A restore is a person's decision about what the form should say, which is
    // exactly what `manual` means. Recording it as `questionnaire` would invite
    // the next population run to overwrite it.
    valueSource: "manual" as const,
    isManualOverride: true,
  }));

  const result = await commitFormValues({
    organizationId,
    caseFormId: form.id,
    writes,
    actor: "staff",
    actorId,
    restoredFromVersionId: versionId,
  });

  log.action(LogEvent.WORKFLOW_FORM_VERSION_RESTORED, {
    caseFormId: form.id,
    restoredFrom: version.versionNumber,
    changed: result.changed,
  });

  return { ...result, restoredFrom: version.versionNumber };
}

/** Puts one field back to what a single revision recorded, as a new version. */
export async function restoreFieldRevision(params: {
  organizationId: string;
  revisionId: string;
  actorId?: string;
}) {
  const { organizationId, revisionId, actorId } = params;

  const [revision] = await db
    .select()
    .from(caseFormFieldRevisions)
    .where(
      and(
        eq(caseFormFieldRevisions.id, revisionId),
        eq(caseFormFieldRevisions.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!revision) throw new NotFoundError("Revision not found");

  const result = await commitFormValues({
    organizationId,
    caseFormId: revision.caseFormId,
    writes: [
      {
        fieldKey: revision.fieldKey,
        value: revision.value,
        valueSource: "manual",
        isManualOverride: true,
      },
    ],
    actor: "staff",
    actorId,
  });

  return { ...result, fieldKey: revision.fieldKey };
}

/**
 * The version a set of forms is currently on, for a package view that wants to
 * say "last saved by X" without a query per form.
 */
export async function latestVersionByForm(caseFormIds: string[]) {
  const byForm = new Map<string, { versionNumber: number; createdAt: Date }>();
  if (caseFormIds.length === 0) return byForm;

  const rows = await db
    .select({
      caseFormId: caseFormVersions.caseFormId,
      versionNumber: caseFormVersions.versionNumber,
      createdAt: caseFormVersions.createdAt,
    })
    .from(caseFormVersions)
    .where(inArray(caseFormVersions.caseFormId, caseFormIds))
    .orderBy(desc(caseFormVersions.versionNumber));

  for (const row of rows) {
    if (byForm.has(row.caseFormId)) continue;
    byForm.set(row.caseFormId, {
      versionNumber: row.versionNumber,
      createdAt: row.createdAt,
    });
  }

  return byForm;
}

const isEmpty = (value: unknown) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

/**
 * Whether two values are the same.
 *
 * Compared as JSON rather than by reference: a value is `jsonb`, so a
 * multi-select comes back as a fresh array on every read and `===` would call
 * every unchanged checkbox a change.
 */
const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
