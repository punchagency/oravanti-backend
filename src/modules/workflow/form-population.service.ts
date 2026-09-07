import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { caseForms } from "../../db/schema/case-forms";
import { cases } from "../../db/schema/cases";
import {
  caseFormFieldValues,
  formFieldMappings,
} from "../../db/schema/form-fields";
import {
  questionnaireAnswers,
  questionnaireLogicRules,
  questionnaireQuestions,
  questionnaireResponses,
  questionnaires,
} from "../../db/schema/questionnaires";
import { hiddenQuestions } from "../../lib/questionnaire/logic";
import { createModuleLogger } from "../../lib/logging/log";
import { NotFoundError } from "../../utils/error/app-error";
import { recordAuditEvent } from "../shared/audit.service";
import {
  catalogueFields,
  catalogueFieldsByForm,
  listCatalogueForms,
} from "./form-catalogue.service";
import { commitFormValues, type FormFieldWrite } from "./form-history.service";
import type { RepeatGroupAnswer } from "./continuation-sheet";
import {
  asRepeatGroupConfig,
  isEntryList,
  parseIndexedKey,
  valueAtIndexedKey,
} from "./repeat-group";

const log = createModuleLogger("workflow.form-population");

/**
 * Carrying a matter's questionnaire answers onto its forms.
 *
 * ─── How a field gets its value ─────────────────────────────────────────────
 *
 * Three routes, in this order:
 *
 *   1. **A mapping**, if one names this field. Per-matter mappings beat
 *      firm-wide ones, because a mapping written for this matter was written
 *      knowing more.
 *   2. **The shared `fieldKey`**, otherwise — an answer to a question whose key
 *      is `beneficiary.date_of_birth` fills every form field of that name. This
 *      is the ordinary route and it needs no configuration at all; see the note
 *      at the top of `db/schema/form-fields.ts`.
 *   3. **One entry of a repeating answer**, for a box whose key reads
 *      `beneficiary.address_history[2].city`. Same idea as route 2 — one
 *      question, many boxes — for the questions that answer more than once.
 *      `repeat-group.ts` holds the grammar and why the index starts at 1.
 *
 * And one rule over all three: **a manual edit is never overwritten.** What the
 * source now says is kept beside it as `sourceValue`, so a client changing
 * their name after a paralegal corrected it surfaces as a disagreement rather
 * than as a silent revert in either direction.
 *
 * Population is therefore safe to re-run, and is: on submission of the
 * questionnaire, and whenever a staff member asks for it.
 */

/** One field's resolved answer, before it is written. */
type ResolvedValue = {
  fieldKey: string;
  value: unknown;
  sourceQuestionId: string;
};

/**
 * One write the pass intends to make.
 *
 * Four kinds because they mean four different things to a person reading the
 * result: a field that had nothing, a field the questionnaire owns and has
 * moved, an edit the questionnaire has just been allowed to replace, and a
 * disagreement recorded but left standing.
 */
type PlannedWrite = {
  kind: "fill" | "update" | "override" | "note-source";
  formId: string;
  fieldKey: string;
  /** What the questionnaire resolved to. Not what the field will end up saying — a `note-source` records the disagreement and leaves the value alone. */
  resolved: unknown;
  sourceQuestionId: string;
};

const isEmpty = (value: unknown) => {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

/**
 * Every answer on the matter's case questionnaire, keyed by question id, with
 * the question's own `fieldKey` alongside.
 *
 * Reads the most recently submitted response, falling back to a draft — a
 * half-finished questionnaire is worth populating from, and the alternative is
 * a Forms tab that stays empty until the client presses submit.
 */
/**
 * The matter repeating answers, for whatever the blank had no room for.
 *
 * A thin door onto `answersForCase` so `form-pdf.service` can read the entries
 * a form does not print without learning how a response is chosen — which is a
 * genuinely fiddly rule (submitted before draft, newest first) that must not
 * end up written twice.
 */
export async function repeatGroupsForCase(
  caseId: string,
  organizationId: string,
) {
  const { repeatGroups } = await answersForCase(caseId, organizationId);
  return repeatGroups;
}

async function answersForCase(caseId: string, organizationId: string) {
  const [response] = await db
    .select({ id: questionnaireResponses.id })
    .from(questionnaireResponses)
    .innerJoin(
      questionnaires,
      eq(questionnaires.id, questionnaireResponses.questionnaireId),
    )
    .where(
      and(
        eq(questionnaireResponses.caseId, caseId),
        eq(questionnaireResponses.organizationId, organizationId),
        eq(questionnaires.stage, "case"),
      ),
    )
    // Submitted before draft, then newest first.
    //
    // Both clauses are explicitly descending, and that is load-bearing. The
    // status enum is declared `["draft", "submitted"]`, so plain ascending
    // order puts drafts *first* — the exact opposite of what the comment
    // promised — and ascending `lastSavedAt` picked the oldest response. On a
    // matter with an empty early draft that combination selected the one row
    // with no answers in it and reported "no answers" forever.
    .orderBy(
      desc(questionnaireResponses.status),
      desc(questionnaireResponses.lastSavedAt),
    )
    .limit(1);

  if (!response) {
    return {
      byQuestionId: new Map(),
      byFieldKey: new Map(),
      repeatGroups: new Map(),
    };
  }

  const rows = await db
    .select({
      questionId: questionnaireAnswers.questionId,
      value: questionnaireAnswers.value,
      fieldKey: questionnaireQuestions.fieldKey,
      config: questionnaireQuestions.config,
      sectionId: questionnaireQuestions.sectionId,
      questionnaireId: questionnaireQuestions.questionnaireId,
    })
    .from(questionnaireAnswers)
    .innerJoin(
      questionnaireQuestions,
      eq(questionnaireQuestions.id, questionnaireAnswers.questionId),
    )
    .where(eq(questionnaireAnswers.responseId, response.id));

  /*
    An answer inside a branch the client collapsed does not reach a form.

    Submission clears these from storage, and this is the second guard rather
    than a duplicate of it: a paralegal can populate from a *draft*, which has
    not been through submission, and staff editing answers on the case tab move
    branches around all day. The rule is the same in both places and comes from
    the same evaluator — an answer the client is not being shown is not one to
    print.
  */
  const questionnaireId = rows[0]?.questionnaireId;
  const rules = questionnaireId
    ? await db
        .select()
        .from(questionnaireLogicRules)
        .where(eq(questionnaireLogicRules.questionnaireId, questionnaireId))
    : [];

  const hidden = rules.length
    ? hiddenQuestions(
        rules,
        new Map(rows.map((row) => [row.questionId, row.value])),
        new Map(rows.map((row) => [row.questionId, row.sectionId])),
      )
    : new Set<string>();

  const byQuestionId = new Map<string, unknown>();
  const byFieldKey = new Map<string, { value: unknown; questionId: string }>();
  /*
    Repeating answers in full, alongside the labels their `config` declares.

    Separate from `byFieldKey` because the two are read for opposite reasons:
    that one answers "what goes in this box", entry by entry, and this one
    answers "what did the client say that the blank had no room for" — which
    needs the entries the form does *not* print and the words to write them out
    in. See `continuation-sheet.ts`.
  */
  const repeatGroups = new Map<string, RepeatGroupAnswer>();

  for (const row of rows) {
    if (isEmpty(row.value)) continue;
    if (hidden.has(row.questionId)) continue;
    byQuestionId.set(row.questionId, row.value);
    if (row.fieldKey) {
      byFieldKey.set(row.fieldKey, {
        value: row.value,
        questionId: row.questionId,
      });

      const group = asRepeatGroupConfig(row.config);
      if (group && isEntryList(row.value)) {
        repeatGroups.set(row.fieldKey, {
          entries: row.value,
          itemLabel: group.itemLabel,
          fields: group.fields,
        });
      }
    }
  }

  return { byQuestionId, byFieldKey, repeatGroups };
}

/**
 * Every mapping, keyed `formCodefieldKey`.
 *
 * No filtering and no precedence rule any more: mappings are the platform's,
 * one per field, identical for every firm. This used to read the firm's rows
 * and the matter's and let the matter's win.
 */
async function allMappings() {
  const rows = await db.select().from(formFieldMappings);
  return new Map(rows.map((row) => [`${row.formCode}${row.fieldKey}`, row]));
}

/**
 * Fill every form on a matter from its case questionnaire.
 *
 * Returns what changed rather than a bare count, because the useful thing to
 * tell a paralegal is which fields moved — and, separately, which of their own
 * edits the questionnaire now disagrees with.
 *
 * ─── dryRun and overrideManual ──────────────────────────────────────────────
 *
 * `dryRun` plans the whole pass and writes none of it, so the confirmation
 * dialog can say "12 fields will be filled, 3 of your edits would be replaced"
 * using the resolution logic that will actually run rather than a second
 * estimate of it that could drift.
 *
 * `overrideManual` is the answer to that dialog: normally a hand edit wins
 * forever and the disagreement is merely surfaced, which is right by default
 * and wrong when the person already knows their value is the stale one. It is
 * deliberately not the default and never automatic — nothing but an explicit
 * request from a person replaces something a person typed.
 */
export async function populateCaseForms(params: {
  caseId: string;
  organizationId: string;
  updatedById?: string;
  /** Replace hand-edited values the questionnaire disagrees with. */
  overrideManual?: boolean;
  /** Plan the pass and report it without writing anything. */
  dryRun?: boolean;
}) {
  const {
    caseId,
    organizationId,
    updatedById,
    overrideManual = false,
    dryRun = false,
  } = params;

  const [caseRow] = await db
    .select({ id: cases.id, caseNumber: cases.caseNumber })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
    .limit(1);
  if (!caseRow) throw new NotFoundError("Case not found");

  const onMatter = await db
    .select({
      id: caseForms.id,
      formCode: caseForms.formCode,
      status: caseForms.status,
    })
    .from(caseForms)
    .where(
      and(
        eq(caseForms.caseId, caseId),
        eq(caseForms.organizationId, organizationId),
      ),
    );

  /*
    A form somebody outside the firm completes is not populated.

    The I-693 is signed and sealed by a civil surgeon. Copying the client
    answers onto our own copy of it produces a form that looks prepared, is
    never printed, and quietly disagrees with the sealed envelope that is
    actually filed. See the note on `form_definitions.provided_by`.
  */
  const provided = new Set(
    (await listCatalogueForms())
      .filter((form) => form.providedBy)
      .map((form) => form.formCode),
  );
  const forms = onMatter.filter((form) => !provided.has(form.formCode));

  if (forms.length === 0) {
    return {
      filled: 0,
      updated: 0,
      overridden: 0,
      conflicts: [],
      skipped: "no forms" as const,
    };
  }

  const { byQuestionId, byFieldKey } = await answersForCase(
    caseId,
    organizationId,
  );
  if (byQuestionId.size === 0) {
    // Nothing to copy, but a form filled by hand is still a form somebody has
    // started — so the status pass runs on this path too, rather than only
    // when the questionnaire had something to give.
    if (!dryRun) await markStartedForms(forms);
    return {
      filled: 0,
      updated: 0,
      overridden: 0,
      conflicts: [],
      skipped: "no answers" as const,
    };
  }

  const mappings = await allMappings();

  const fieldsByForm = await catalogueFieldsByForm(
    forms.map((f) => f.formCode),
  );

  const existing = await db
    .select()
    .from(caseFormFieldValues)
    .where(
      inArray(
        caseFormFieldValues.caseFormId,
        forms.map((f) => f.id),
      ),
    );
  const existingByKey = new Map(
    existing.map((v) => [`${v.caseFormId}${v.fieldKey}`, v]),
  );

  // The pass is planned in full before any of it is written. That is what lets
  // `dryRun` report exactly what a real run would do — one code path, asked
  // whether to execute — instead of a second estimate that drifts from it.
  const plan: PlannedWrite[] = [];
  const conflicts: { formCode: string; fieldKey: string }[] = [];

  for (const form of forms) {
    for (const field of fieldsByForm.get(form.formCode) ?? []) {
      const resolved = resolve(field.formCode, field.fieldKey);
      if (!resolved) continue;

      const key = `${form.id}${field.fieldKey}`;
      const current = existingByKey.get(key);

      // Nothing there yet — write it.
      if (!current) {
        plan.push({
          kind: "fill",
          formId: form.id,
          fieldKey: field.fieldKey,
          resolved: resolved.value,
          sourceQuestionId: resolved.sourceQuestionId,
        });
        continue;
      }

      const disagrees =
        JSON.stringify(current.value) !== JSON.stringify(resolved.value);

      // A person edited this. Their value stands unless they have just asked
      // for it not to; either way the source value is recorded, so the
      // disagreement is visible rather than resolved silently.
      if (current.isManualOverride) {
        if (disagrees) {
          conflicts.push({ formCode: form.formCode, fieldKey: field.fieldKey });
        }

        if (overrideManual && disagrees) {
          plan.push({
            kind: "override",
            formId: form.id,
            fieldKey: field.fieldKey,
            resolved: resolved.value,
            sourceQuestionId: resolved.sourceQuestionId,
          });
          continue;
        }

        if (
          JSON.stringify(current.sourceValue) !== JSON.stringify(resolved.value)
        ) {
          plan.push({
            kind: "note-source",
            formId: form.id,
            fieldKey: field.fieldKey,
            resolved: resolved.value,
            sourceQuestionId: resolved.sourceQuestionId,
          });
        }
        continue;
      }

      // Source-owned and unchanged — leave it alone rather than churn updatedAt.
      if (!disagrees) continue;

      plan.push({
        kind: "update",
        formId: form.id,
        fieldKey: field.fieldKey,
        resolved: resolved.value,
        sourceQuestionId: resolved.sourceQuestionId,
      });
    }
  }

  const filled = plan.filter((w) => w.kind === "fill").length;
  const updated = plan.filter((w) => w.kind === "update").length;
  const overridden = plan.filter((w) => w.kind === "override").length;

  if (dryRun) {
    return { filled, updated, overridden, conflicts, skipped: null };
  }

  // Written one form at a time, because a version is per form: a run touching
  // five forms leaves a version on each, so opening the I-485's history shows
  // the I-485 and nothing else.
  for (const form of forms) {
    const writes = plan
      .filter((w) => w.formId === form.id)
      .map((write): FormFieldWrite => {
        const existing = existingByKey.get(`${form.id}${write.fieldKey}`);

        // A disagreement recorded and left standing: the hand edit keeps the
        // field, and what the questionnaire now says is stored beside it.
        if (write.kind === "note-source") {
          return {
            fieldKey: write.fieldKey,
            value: existing?.value ?? null,
            valueSource: existing?.valueSource ?? "manual",
            isManualOverride: true,
            sourceValue: write.resolved,
            sourceQuestionId: existing?.sourceQuestionId ?? null,
          };
        }

        return {
          fieldKey: write.fieldKey,
          value: write.resolved,
          valueSource: "questionnaire",
          // An override hands the field back to the questionnaire: clearing
          // `isManualOverride` is what stops the next run from treating the
          // value it has just written as somebody's edit and refusing to touch
          // it again.
          isManualOverride: false,
          sourceValue: write.kind === "override" ? write.resolved : undefined,
          sourceQuestionId: write.sourceQuestionId,
        };
      });

    if (writes.length === 0) continue;

    await commitFormValues({
      organizationId,
      caseFormId: form.id,
      writes,
      actor: "questionnaire",
      actorId: updatedById,
    });
  }

  await markStartedForms(forms);

  if (filled || updated || overridden) {
    // Replacing a hand edit is the part of this that somebody may later need to
    // account for, so it is named in the summary rather than folded into the
    // update count.
    const left = conflicts.length - overridden;
    await recordAuditEvent({
      action: "case.form_fields_populated",
      entityType: "case",
      entityId: caseId,
      parentEntityType: "case",
      parentEntityId: caseId,
      organizationId,
      summary:
        `Forms on ${caseRow.caseNumber} filled from the case questionnaire: ` +
        `${filled} field${filled === 1 ? "" : "s"} added, ${updated} updated` +
        (overridden
          ? `, ${overridden} hand-edited field${overridden === 1 ? "" : "s"} replaced at the staff member's request`
          : "") +
        (left > 0 ? `, ${left} left as edited by hand` : ""),
      metadata: { filled, updated, overridden, conflicts },
    });
  }

  log.action("workflow.form_fields_populated", {
    caseId,
    filled,
    updated,
    overridden,
    conflicts: conflicts.length,
  });

  return { filled, updated, overridden, conflicts, skipped: null };

  /** A mapping if one names this field, the shared key otherwise. */
  function resolve(formCode: string, fieldKey: string): ResolvedValue | null {
    const mapping = mappings.get(`${formCode}${fieldKey}`);
    if (mapping) {
      const value = byQuestionId.get(mapping.sourceQuestionId);
      // A mapping whose question has been deleted fills nothing. Deliberately
      // not falling through to the shared key: someone asked for this field to
      // come from that question, and quietly using a different source would be
      // worse than leaving it empty for them to notice.
      if (value === undefined) return null;
      return {
        fieldKey,
        value,
        sourceQuestionId: mapping.sourceQuestionId,
      };
    }

    const shared = byFieldKey.get(fieldKey);
    if (shared) {
      return {
        fieldKey,
        value: shared.value,
        sourceQuestionId: shared.questionId,
      };
    }

    /*
      A box naming one entry of a repeating answer — `...address_history[2].city`.

      Tried last, and only when the whole key matched nothing: an ordinary key
      that happens to contain brackets is still an ordinary key, and the
      question that owns it should win over a parse of its name.
    */
    const indexed = parseIndexedKey(fieldKey);
    if (!indexed) return null;

    const group = byFieldKey.get(indexed.base);
    if (!group) return null;

    const value = valueAtIndexedKey(group.value, indexed);
    // An entry the client does not have. Deliberately not filled with a blank:
    // stamping entry 2's boxes for someone who has lived at one address turns
    // an empty block into an answered one.
    if (value === undefined) return null;

    return { fieldKey, value, sourceQuestionId: group.questionId };
  }
}

/**
 * One form's fields, as the Forms tab shows them: the catalogue in the form's
 * own order, each with its value and where that value came from.
 *
 * Built from the catalogue rather than from the stored values, so a field
 * nothing has filled still appears — an empty box on a form is information.
 */
export async function readCaseForm(params: {
  caseId: string;
  formCode: string;
  organizationId: string;
}) {
  const { caseId, formCode, organizationId } = params;

  const [form] = await db
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
  if (!form) throw new NotFoundError(`${formCode} is not on this matter`);

  const [definitions, values] = await Promise.all([
    catalogueFields(formCode),
    db
      .select()
      .from(caseFormFieldValues)
      .where(eq(caseFormFieldValues.caseFormId, form.id)),
  ]);

  const byFieldKey = new Map(values.map((v) => [v.fieldKey, v]));

  const fields = definitions.map((d) => {
    const v = byFieldKey.get(d.fieldKey);
    return {
      /** The catalogue row id. Read-only to a firm; the CRM edits by it. */
      id: d.id,
      fieldKey: d.fieldKey,
      label: d.label,
      partLabel: d.partLabel,
      type: d.type,
      helpText: d.helpText,
      config: d.config,
      isRequired: d.isRequired,
      value: v?.value ?? null,
      valueSource: v?.valueSource ?? null,
      isManualOverride: v?.isManualOverride ?? false,
      /**
       * Present only when a hand-edited field and its source disagree. The UI
       * shows this as "the questionnaire now says X" beside the value, which is
       * the whole reason the override is not silently overwritten.
       */
      conflictsWith:
        v?.isManualOverride &&
        v.sourceValue !== null &&
        JSON.stringify(v.sourceValue) !== JSON.stringify(v.value)
          ? v.sourceValue
          : null,
    };
  });

  const fillable = fields.length;
  const populated = fields.filter((f) => !isEmpty(f.value)).length;

  return {
    form,
    fields,
    completion: {
      populated,
      total: fillable,
      percentage: fillable > 0 ? Math.round((populated / fillable) * 100) : 0,
      /** Required fields still empty — what stops the form being filed. */
      missingRequired: fields
        .filter((f) => f.isRequired && isEmpty(f.value))
        .map((f) => f.fieldKey),
    },
  };
}
/**
 * A staff member editing fields by hand.
 *
 * Takes a batch because that is how the Forms tab saves — a whole form at a
 * time, on an explicit Save, the same shape the questionnaire uses. Each value
 * is marked as a manual override, which is what protects it from the next
 * population run, and whatever the source said is kept in `sourceValue` so the
 * two can be compared afterwards.
 */
export async function setCaseFormFields(params: {
  caseId: string;
  formCode: string;
  fields: { fieldKey: string; value: unknown }[];
  organizationId: string;
  updatedById?: string;
}) {
  const { caseId, formCode, fields, organizationId, updatedById } = params;

  const [form] = await db
    .select({ id: caseForms.id, status: caseForms.status })
    .from(caseForms)
    .where(
      and(
        eq(caseForms.caseId, caseId),
        eq(caseForms.formCode, formCode),
        eq(caseForms.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!form) throw new NotFoundError(`${formCode} is not on this matter`);

  if (fields.length === 0) return { saved: [] };

  // Every key is checked against the catalogue before anything is written, so a
  // batch containing one bad key fails whole rather than half-applying.
  const known = new Set(
    (await catalogueFields(formCode)).map((d) => d.fieldKey),
  );
  const unknown = fields.find((f) => !known.has(f.fieldKey));
  if (unknown) {
    throw new NotFoundError(`${formCode} has no field "${unknown.fieldKey}"`);
  }

  const existing = await db
    .select()
    .from(caseFormFieldValues)
    .where(
      and(
        eq(caseFormFieldValues.caseFormId, form.id),
        inArray(
          caseFormFieldValues.fieldKey,
          fields.map((f) => f.fieldKey),
        ),
      ),
    );
  const existingByKey = new Map(existing.map((v) => [v.fieldKey, v]));

  const result = await commitFormValues({
    organizationId,
    caseFormId: form.id,
    actor: "staff",
    actorId: updatedById,
    writes: fields.map((field) => {
      const current = existingByKey.get(field.fieldKey);
      return {
        fieldKey: field.fieldKey,
        value: field.value,
        valueSource: "manual" as const,
        isManualOverride: true,
        // What the source said becomes the thing this edit disagrees with.
        // Taken from the value being replaced only when that value came from a
        // source — one manual edit following another has nothing to disagree
        // with, and `undefined` leaves the stored disagreement standing.
        sourceValue:
          current === undefined || current.valueSource === "manual"
            ? undefined
            : current.value,
      };
    }),
  });

  // A form somebody has started filling by hand is a form in preparation, with
  // or without a questionnaire behind it.
  await markStartedForms([form]);

  return {
    saved: result.values,
    changed: result.changed,
    version: result.version,
  };
}

/** One field, for callers that have exactly one. */
export async function setCaseFormField(params: {
  caseId: string;
  formCode: string;
  fieldKey: string;
  value: unknown;
  organizationId: string;
  updatedById?: string;
}) {
  const { fieldKey, value, ...rest } = params;
  const { saved } = await setCaseFormFields({
    ...rest,
    fields: [{ fieldKey, value }],
  });
  // `saved` is the whole form, so the one field is found rather than indexed —
  // it is absent when the value was emptied, which is a deletion.
  return saved.find((row) => row.fieldKey === fieldKey) ?? null;
}

/**
 * Move any form that has values on it off `not_started`.
 *
 * Keyed on the form *having* values rather than on a particular run writing
 * them. Tying it to the run left every form populated before this rule existed
 * stuck on `not_started` for good: a re-run finds the values already correct,
 * writes nothing, and so nudges nothing. Asking the question this way makes the
 * pass idempotent and self-healing, and lets it also cover a form somebody
 * filled by hand with no questionnaire behind it.
 *
 * Only the opening state moves. A form already filed or receipted must never be
 * dragged backwards by a late questionnaire edit.
 */
async function markStartedForms(
  forms: { id: string; status: string }[],
): Promise<void> {
  const candidates = forms.filter((f) => f.status === "not_started");
  if (candidates.length === 0) return;

  const withValues = await db
    .selectDistinct({ caseFormId: caseFormFieldValues.caseFormId })
    .from(caseFormFieldValues)
    .where(
      inArray(
        caseFormFieldValues.caseFormId,
        candidates.map((f) => f.id),
      ),
    );

  if (withValues.length === 0) return;

  await db
    .update(caseForms)
    .set({ status: "in_preparation", updatedAt: new Date() })
    .where(
      inArray(
        caseForms.id,
        withValues.map((v) => v.caseFormId),
      ),
    );
}
