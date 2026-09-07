import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import {
  formFieldMappings,
  formParts as formPartsTable,
} from "../../db/schema/form-fields";
import {
  questionnaireQuestions,
  questionnaires,
  questionnaireSections,
} from "../../db/schema/questionnaires";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import {
  catalogueFields,
  catalogueFieldsByForm,
  type CatalogueField,
} from "./form-catalogue.service";
import { formPdfService } from "./form-pdf.service";

const log = createModuleLogger("workflow.form-mappings");

/**
 * Which question fills which form field, and the screen that answers it.
 *
 * Most fields need nothing here. A question and a field connect because both
 * name the same datum — `beneficiary.date_of_birth` — and that shared key does
 * the work with no configuration at all. A row in `form_field_mappings` is the
 * exception: a field whose shared key resolves to the wrong question, or to no
 * question, and where somebody has decided what should fill the box instead.
 *
 * ─── Oravanti's, not a firm's ───────────────────────────────────────────────
 *
 * This whole module used to be firm-facing, reached from a matter, and a
 * mapping carried `scope: firm | case` so one firm could wire its own question
 * onto a field. That is gone with the tier it served: a firm no longer authors
 * form fields, so it has no unmapped field of its own to point at, and
 * repointing one of *ours* is a decision about the form rather than about the
 * matter somebody happens to be standing in.
 *
 * The consequence worth stating plainly: this is global reference data. One
 * row decides what fills that box for every firm in the deployment. It was
 * reachable with `cases:update` and is now reachable only with
 * `requirePlatformAdmin`.
 *
 * The read still returns every field — mapped, shared-key, or unfed — because
 * "what fills this box?" is a question about the whole form, and a screen that
 * showed only the exceptions could not answer it.
 */

type FeedSource = "mapping" | "shared_key" | "none";

/**
 * One part of a form, field by field, with what feeds each.
 *
 * One query per table rather than a join per field: assembling it in memory
 * keeps the precedence rule in one readable place instead of spread across SQL.
 *
 * ─── A part at a time, and the questions separately ─────────────────────────
 *
 * The I-485 is 512 fields and the list of questions that could feed them is
 * another 250. Sent together, every move between parts re-sent both. So the
 * screen asks for the part it is showing, and asks `formSourceQuestions` once
 * for the vocabulary — which is the same list whichever part is open.
 */
export async function getFormFieldMap(params: {
  formCode: string;
  partLabel?: string | null;
  caseTypeId?: string | null;
}) {
  const { formCode, partLabel, caseTypeId } = params;

  const [fields, mappings, questions] = await Promise.all([
    catalogueFields(formCode, partLabel),
    db
      .select()
      .from(formFieldMappings)
      .where(eq(formFieldMappings.formCode, formCode)),
    platformQuestions(caseTypeId),
  ]);

  const byField = new Map(mappings.map((row) => [row.fieldKey, row]));
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const questionByFieldKey = new Map(
    questions.filter((q) => q.fieldKey).map((q) => [q.fieldKey as string, q]),
  );

  return { form: { formCode, fields: fields.map(describeField) } };

  function describeField(definition: CatalogueField) {
    const mapping = byField.get(definition.fieldKey);
    const shared = questionByFieldKey.get(definition.fieldKey);

    // A mapping naming a deleted question is shown as broken rather than
    // quietly falling back to the shared key — see the schema note on why the
    // column has no foreign key.
    const mapped = mapping ? questionById.get(mapping.sourceQuestionId) : undefined;
    const source: FeedSource = mapping ? "mapping" : shared ? "shared_key" : "none";
    const question = mapping ? mapped : shared;

    return {
      fieldKey: definition.fieldKey,
      label: definition.label,
      partLabel: definition.partLabel,
      type: definition.type,
      isRequired: definition.isRequired,
      source,
      /** True when a mapping exists but the question behind it is gone. */
      isBroken: Boolean(mapping && !mapped),
      mappingId: mapping?.id ?? null,
      overridesSharedKey: mapping?.overridesSharedKey ?? false,
      overrideRationale: mapping?.overrideRationale ?? null,
      question: question
        ? {
            id: question.id,
            label: question.label,
            sectionTitle: question.sectionTitle,
          }
        : null,
    };
  }
}

/**
 * The vocabulary a form field can be pointed at, read once per screen.
 *
 * Split out from `getFormFieldMap` when that became a per-part read: the
 * questions do not change from Part 1 to Part 9, so re-sending them with each
 * part was the largest half of every request and none of it was new.
 */
export async function formSourceQuestions(caseTypeId?: string | null) {
  return { questions: await platformQuestions(caseTypeId) };
}

/**
 * The platform's own questions, flattened, with their section for context.
 *
 * `scope: system` only. A firm's question can no longer feed a form field —
 * mappings are global, and a mapping pointing at one firm's question would
 * leave the field unfed for every other firm while looking configured. A firm
 * that needs its own answer on a form is asking for a change to the form,
 * which is a request to Oravanti rather than a setting.
 */
async function platformQuestions(caseTypeId?: string | null) {
  return db
    .select({
      id: questionnaireQuestions.id,
      label: questionnaireQuestions.label,
      fieldKey: questionnaireQuestions.fieldKey,
      type: questionnaireQuestions.type,
      sectionTitle: questionnaireSections.title,
      orderIndex: questionnaireQuestions.orderIndex,
    })
    .from(questionnaireQuestions)
    .innerJoin(
      questionnaires,
      eq(questionnaires.id, questionnaireQuestions.questionnaireId),
    )
    .innerJoin(
      questionnaireSections,
      eq(questionnaireSections.id, questionnaireQuestions.sectionId),
    )
    .where(
      and(
        eq(questionnaires.stage, "case"),
        isNull(questionnaireQuestions.organizationId),
        ...(caseTypeId ? [eq(questionnaires.caseTypeId, caseTypeId)] : []),
      ),
    )
    .orderBy(
      asc(questionnaireSections.orderIndex),
      asc(questionnaireQuestions.orderIndex),
    );
}

/**
 * A form's parts, with how much of each is wired up.
 *
 * ─── The index the CRM's form screens navigate by ───────────────────────────
 *
 * A form is read a part at a time now — the I-485 is 512 fields and 14 parts —
 * so this is what the part picker is built from and the only whole-form read
 * those screens make. Three numbers because the three views ask three
 * questions of the same part: how many fields it has (Contents), how many have
 * something feeding them (Field sources), and how many print somewhere on the
 * blank (PDF boxes).
 *
 * Grouped by label rather than by run. The rest of the codebase groups runs, to
 * avoid reordering a form whose fields interleave two parts — but a picker
 * whose list had "Part 1" twice in it would be a worse answer than an
 * interleave, and every field of a part is shown in print order within it
 * either way.
 *
 * `sourcedCount` follows the same precedence the field-map screen renders: an
 * explicit mapping, or a question that shares the field's key. Counting only
 * the mappings would report almost every part as unwired, because the shared
 * key is how most fields are fed and a row in `form_field_mappings` is the
 * exception.
 */
export type FormPart = {
  partLabel: string | null;
  /** What the part is for, where somebody has said. See `form_parts`. */
  description: string | null;
  fieldCount: number;
  sourcedCount: number;
  mappedCount: number;
};

/**
 * The form's parts, in the order the blank prints them.
 *
 * The list is a **union of two things**, and which half a part comes from is
 * not something a caller needs to care about:
 *
 * - every distinct `partLabel` the form's fields carry, which is what the
 *   extraction produced and what fixes the order;
 * - every row in `form_parts`, which is how a part gets a description and how
 *   an operator names one *before* it has any fields.
 *
 * A described part with fields is one entry, not two. A part with a row and no
 * fields sorts last, because there is no field order to place it by — which is
 * also where somebody who just created it expects to find it.
 */
export async function formParts(formCode: string): Promise<FormPart[]> {
  const [fields, mappings, questions, boxed, described] = await Promise.all([
    catalogueFields(formCode),
    db
      .select({ fieldKey: formFieldMappings.fieldKey })
      .from(formFieldMappings)
      .where(eq(formFieldMappings.formCode, formCode)),
    platformQuestions(),
    formPdfService.mappedFieldKeys(formCode),
    db
      .select({
        partLabel: formPartsTable.partLabel,
        description: formPartsTable.description,
      })
      .from(formPartsTable)
      .where(eq(formPartsTable.formCode, formCode))
      .orderBy(asc(formPartsTable.partLabel)),
  ]);

  const fed = new Set([
    ...mappings.map((row) => row.fieldKey),
    ...questions.flatMap((q) => (q.fieldKey ? [q.fieldKey] : [])),
  ]);

  const parts: FormPart[] = [];
  const byLabel = new Map<string, FormPart>();

  for (const field of fields) {
    const key = field.partLabel ?? "";
    let part = byLabel.get(key);
    if (!part) {
      part = {
        partLabel: field.partLabel,
        description: null,
        fieldCount: 0,
        sourcedCount: 0,
        mappedCount: 0,
      };
      byLabel.set(key, part);
      parts.push(part);
    }
    part.fieldCount += 1;
    if (fed.has(field.fieldKey)) part.sourcedCount += 1;
    if (boxed.has(field.fieldKey)) part.mappedCount += 1;
  }

  // The described half. A part the fields already produced gains its sentence;
  // one they did not is an empty part, appended.
  for (const row of described) {
    const part = byLabel.get(row.partLabel);
    if (part) {
      part.description = row.description;
      continue;
    }
    parts.push({
      partLabel: row.partLabel,
      description: row.description,
      fieldCount: 0,
      sourcedCount: 0,
      mappedCount: 0,
    });
  }

  return parts;
}

/** Point a form field at a question. Platform only. */
export async function setFormFieldMapping(params: {
  formCode: string;
  fieldKey: string;
  sourceQuestionId: string;
  overrideRationale?: string | null;
}) {
  const { formCode, fieldKey, sourceQuestionId } = params;

  const definition = (await catalogueFields(formCode)).find(
    (f) => f.fieldKey === fieldKey,
  );
  if (!definition) {
    throw new NotFoundError(`${formCode} has no field named ${fieldKey}`);
  }

  const [question] = await db
    .select({
      id: questionnaireQuestions.id,
      fieldKey: questionnaireQuestions.fieldKey,
    })
    .from(questionnaireQuestions)
    .where(
      and(
        eq(questionnaireQuestions.id, sourceQuestionId),
        // A mapping is read by every firm, so it may only name a question
        // every firm has. Pointing at a firm's own question would leave the
        // field unfed everywhere else while the screen showed it configured.
        isNull(questionnaireQuestions.organizationId),
      ),
    )
    .limit(1);
  if (!question) {
    throw new NotFoundError(
      "Question not found, or it belongs to one firm rather than the platform",
    );
  }

  // Displacing the shared vocabulary is allowed but never silent: if some
  // other question already carries this field key, the mapping has to say why.
  const [sharedOwner] = await db
    .select({ id: questionnaireQuestions.id })
    .from(questionnaireQuestions)
    .where(eq(questionnaireQuestions.fieldKey, fieldKey))
    .limit(1);

  const overridesSharedKey = Boolean(
    sharedOwner && sharedOwner.id !== sourceQuestionId,
  );
  if (overridesSharedKey && !params.overrideRationale?.trim()) {
    throw new BadRequestError(
      `Another question already fills ${fieldKey}. Say why this one should replace it.`,
    );
  }

  const [saved] = await db
    .insert(formFieldMappings)
    .values({
      formCode,
      fieldKey,
      sourceQuestionId,
      overridesSharedKey,
      overrideRationale: params.overrideRationale?.trim() || null,
    })
    .onConflictDoUpdate({
      target: [formFieldMappings.formCode, formFieldMappings.fieldKey],
      set: {
        sourceQuestionId,
        overridesSharedKey,
        overrideRationale: params.overrideRationale?.trim() || null,
        updatedAt: new Date(),
      },
    })
    .returning();

  log.action(LogEvent.WORKFLOW_FORM_FIELD_MAPPED, {
    formCode,
    fieldKey,
    overridesSharedKey,
  });

  return saved;
}

/**
 * Remove a mapping, returning the field to whatever the shared vocabulary
 * says.
 *
 * Deliberately does not clear values already on any matter's form: a mapping
 * decides where future answers come from, not what a form currently says.
 */
export async function clearFormFieldMapping(params: { mappingId: string }) {
  const [deleted] = await db
    .delete(formFieldMappings)
    .where(eq(formFieldMappings.id, params.mappingId))
    .returning();

  if (!deleted) throw new NotFoundError("Mapping not found");

  log.action(LogEvent.WORKFLOW_FORM_FIELD_UNMAPPED, {
    formCode: deleted.formCode,
    fieldKey: deleted.fieldKey,
  });

  return deleted;
}

/**
 * Every mapping on one form, saved together.
 *
 * The unit is the form, matching how the wiring screen is worked: somebody
 * goes through one form and presses Save once.
 *
 * A null `sourceQuestionId` clears the mapping. Every key is checked against
 * the catalogue before anything is written, so a batch containing one bad key
 * fails whole rather than half-applying.
 */
export async function setFormFieldMappings(params: {
  formCode: string;
  mappings: {
    fieldKey: string;
    sourceQuestionId: string | null;
    overrideRationale?: string | null;
  }[];
}) {
  const { formCode, mappings } = params;
  if (mappings.length === 0) return { saved: 0, cleared: 0 };

  const known = new Set((await catalogueFields(formCode)).map((f) => f.fieldKey));
  const unknown = mappings.find((m) => !known.has(m.fieldKey));
  if (unknown) {
    throw new NotFoundError(`${formCode} has no field named ${unknown.fieldKey}`);
  }

  let saved = 0;
  let cleared = 0;

  for (const mapping of mappings) {
    if (mapping.sourceQuestionId) {
      await setFormFieldMapping({
        formCode,
        fieldKey: mapping.fieldKey,
        sourceQuestionId: mapping.sourceQuestionId,
        overrideRationale: mapping.overrideRationale,
      });
      saved++;
      continue;
    }

    // Clearing a field that had no mapping is a no-op rather than an error:
    // the caller is describing the state it wants, not the delta it computed.
    const [removed] = await db
      .delete(formFieldMappings)
      .where(
        and(
          eq(formFieldMappings.formCode, formCode),
          eq(formFieldMappings.fieldKey, mapping.fieldKey),
        ),
      )
      .returning();

    if (removed) {
      cleared++;
      log.action(LogEvent.WORKFLOW_FORM_FIELD_UNMAPPED, {
        formCode,
        fieldKey: mapping.fieldKey,
      });
    }
  }

  return { saved, cleared };
}

/**
 * Which question feeds each field, across every form on one matter.
 *
 * The firm-facing read, and read-only on purpose. Its Questionnaire tab labels
 * each question with what it fills — "fills I-485 · Date of Birth" — which is a
 * question about the package rather than about one form, and it is the one
 * thing a firm still legitimately asks of the mapping data.
 *
 * The write that used to sit beside it is gone. `PUT /cases/:caseId/field-map`
 * was reachable with `cases:update` and wrote a row that decided the answer for
 * every firm in the deployment; there is no per-matter mapping any more, so
 * there is nothing here for a firm to change. What is left is exactly the read.
 *
 * Takes a list of form codes rather than a case id: the caller has already
 * established which matter it is and which forms are on it, and passing the
 * codes keeps this function out of the business of checking access to a case.
 */
export async function getFeedsForForms(formCodes: string[]) {
  if (formCodes.length === 0) return { forms: [] };

  const [fieldsByForm, mappings, questions] = await Promise.all([
    catalogueFieldsByForm(formCodes),
    db
      .select()
      .from(formFieldMappings)
      .where(inArray(formFieldMappings.formCode, formCodes)),
    platformQuestions(),
  ]);

  const questionById = new Map(questions.map((q) => [q.id, q]));
  const questionByFieldKey = new Map(
    questions.filter((q) => q.fieldKey).map((q) => [q.fieldKey as string, q]),
  );
  const mappingByKey = new Map(
    mappings.map((row) => [`${row.formCode}::${row.fieldKey}`, row]),
  );

  return {
    forms: formCodes.map((formCode) => ({
      formCode,
      fields: (fieldsByForm.get(formCode) ?? []).map((field) => {
        const mapping = mappingByKey.get(`${formCode}::${field.fieldKey}`);
        // A mapping wins over the shared key, and a mapping naming a deleted
        // question feeds nothing rather than quietly falling back — the same
        // precedence `getFormFieldMap` applies, stated once per reader.
        const question = mapping
          ? questionById.get(mapping.sourceQuestionId)
          : questionByFieldKey.get(field.fieldKey);

        return {
          fieldKey: field.fieldKey,
          label: field.label,
          question: question
            ? { id: question.id, label: question.label }
            : null,
        };
      }),
    })),
  };
}
