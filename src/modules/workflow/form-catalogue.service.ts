import { and, asc, eq, inArray, isNull, notLike } from "drizzle-orm";
import { db } from "../../db/client";
import {
  formDefinitions,
  formFieldDefinitions,
  formParts,
  formPracticeAreas,
} from "../../db/schema/form-fields";
import { questionnaireQuestionTypeEnum } from "../../db/schema/enums";
import { practiceAreas } from "../../db/schema/practice-areas";
import { schemaNodes } from "../../db/schema/schema-nodes";
import { parseIndexedKey, pathOf } from "./repeat-group";
import { formLocalPrefix } from "./pdf-field-naming";

import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

type QuestionnaireQuestionType =
  (typeof questionnaireQuestionTypeEnum.enumValues)[number];

/**
 * The form catalogue: what each form is, and what is printed on it.
 *
 * ─── One tier, and why ──────────────────────────────────────────────────────
 *
 * This file used to merge three tiers — the platform's rows, a firm's, and one
 * matter's — with a firm's edit of a platform row stored as a *copy* carrying
 * `supersedes_id`. All of that is gone. The catalogue is Oravanti's alone:
 *
 *   A questionnaire is a conversation with a client, and a firm may extend it.
 *   A form is a government blank. Nobody but the government changes what is on
 *   an I-485, and Oravanti is the party that tracks what the government did.
 *
 * So there is nothing to merge, nothing to supersede, and no `isLocked` or
 * `isEdited` for a caller to branch on — every row here belongs to the
 * platform, and a firm reading this catalogue is reading the only version of
 * it there is. A firm that needs to capture something the form does not ask
 * for adds a *question*, which is the tier that stays open to them.
 *
 * ─── Who calls what ─────────────────────────────────────────────────────────
 *
 * The reads are shared: a firm's Forms tab and the CRM render the same
 * catalogue, and a second copy of "list the fields on a form" is exactly the
 * drift this consolidation exists to prevent. The writes are reachable only
 * through `/platform`, gated by `requirePlatformAdmin`.
 */

export type CatalogueForm = {
  id: string;
  formCode: string;
  title: string;
  description: string | null;
  /**
   * Who completes the form when it is not the firm, as an instruction to
   * follow. See `form_definitions.provided_by` — set on the I-693 and nothing
   * else today. A form that has one is not filled, not populated, and not
   * merged into the package; the envelope is.
   */
  providedBy: string | null;
};

export type CatalogueField = {
  id: string;
  formCode: string;
  fieldKey: string;
  label: string;
  partLabel: string | null;
  type: QuestionnaireQuestionType;
  orderIndex: number;
  helpText: string | null;
  config: unknown;
  isRequired: boolean;
  /**
   * The vocabulary node this box prints, or null where it carries the form own
   * name for something nothing else asks.
   *
   * The mapper paints its overlay from this: green carries a datum and will
   * print, amber is mapped to a box the form named itself and prints blank,
   * grey is unmapped. That used to be inferred from the shape of the key; it
   * is a foreign key now, so the overlay, the coverage bar and population all
   * read one column.
   */
  schemaNodeId: string | null;
  /** Which entry of a repeating node, counting from 1. Null when it is not one. */
  entryIndex: number | null;
};

// ─── Reading ────────────────────────────────────────────────────────────────

/** Every form in the catalogue, in code order. */
export async function listCatalogueForms(): Promise<CatalogueForm[]> {
  return db
    .select({
      id: formDefinitions.id,
      formCode: formDefinitions.formCode,
      title: formDefinitions.title,
      description: formDefinitions.description,
      providedBy: formDefinitions.providedBy,
    })
    .from(formDefinitions)
    .orderBy(asc(formDefinitions.formCode));
}

/**
 * The catalogue entry for one code, or null.
 *
 * Null is an ordinary answer rather than an error: a matter may carry a form
 * nothing has catalogued yet, and the Forms tab shows the bare code until
 * somebody names it in the CRM.
 */
export async function catalogueForm(
  formCode: string,
): Promise<CatalogueForm | null> {
  const [form] = await db
    .select({
      id: formDefinitions.id,
      formCode: formDefinitions.formCode,
      title: formDefinitions.title,
      description: formDefinitions.description,
      providedBy: formDefinitions.providedBy,
    })
    .from(formDefinitions)
    .where(eq(formDefinitions.formCode, formCode))
    .limit(1);

  return form ?? null;
}

/** The fields on a set of forms, keyed by form code and in printing order. */
export async function catalogueFieldsByForm(
  formCodes: string[],
): Promise<Map<string, CatalogueField[]>> {
  const byForm = new Map<string, CatalogueField[]>();
  if (formCodes.length === 0) return byForm;

  const rows = await db
    .select()
    .from(formFieldDefinitions)
    .where(inArray(formFieldDefinitions.formCode, formCodes))
    .orderBy(
      asc(formFieldDefinitions.formCode),
      asc(formFieldDefinitions.orderIndex),
    );

  for (const row of rows) {
    const list = byForm.get(row.formCode) ?? [];
    list.push(toCatalogueField(row));
    byForm.set(row.formCode, list);
  }

  return byForm;
}

/**
 * The fields on one form, in the order it prints — all of them, or one part.
 *
 * `partLabel` has three states and they are three different answers:
 * `undefined` is the whole form, a string is that part, and `null` is the part
 * of a form whose fields carry no part label at all. The distinction matters
 * because the screens ask per part now: handing back 512 fields to a caller
 * that asked for the unlabelled one would look like it worked.
 */
export async function catalogueFields(
  formCode: string,
  partLabel?: string | null,
): Promise<CatalogueField[]> {
  const rows = await db
    .select()
    .from(formFieldDefinitions)
    .where(
      and(
        eq(formFieldDefinitions.formCode, formCode),
        partLabel === undefined
          ? undefined
          : partLabel === null
            ? isNull(formFieldDefinitions.partLabel)
            : eq(formFieldDefinitions.partLabel, partLabel),
      ),
    )
    .orderBy(asc(formFieldDefinitions.orderIndex));

  return rows.map(toCatalogueField);
}

/** One name a question can be wired to, and where it prints. */
export type VocabularyField = {
  fieldKey: string;
  /**
   * What to call it. A shared datum uses its node's label — written by hand,
   * for a person — in preference to the first box's, which is the USCIS
   * tooltip and reads like one: *"18. Enter Street Number and Name."*
   */
  label: string;
  /** Every form that prints it, in code order. */
  formCodes: string[];
  /**
   * The datum's domain — beneficiary, petitioner, marriage — or null for a
   * form's own name for a box. This is what the picker groups by, and it comes
   * from `schema_nodes.category` rather than from splitting the key, so the
   * grouping is the vocabulary's own and needs no table to maintain.
   */
  category: string | null;
  /**
   * Whether an answer to this is per entry — a list, or something inside one.
   *
   * A question may be wired to a list (`beneficiary.address_history` is one
   * question answering many times); a *box* may not, because a box holds one
   * value. The two pickers therefore offer different halves of this list, and
   * this is the flag they split on.
   */
  isRepeating: boolean;
};

/**
 * Every name the catalogued forms can be filled from, once each.
 *
 * ─── Why a question needs this list, not a text box ─────────────────────────
 *
 * `populateCaseForms` fills purely by matching `fieldKey`, so a question whose
 * key is one character off the box's fills nothing — and nothing says so. The
 * form simply prints blank, weeks later, in a filing. Typing the key by hand
 * was a control with exactly one failure mode and no feedback on it; choosing
 * from what the catalogue actually holds cannot miss.
 *
 * The list is every distinct key across every catalogued form, which is both
 * kinds of name at once and deliberately so:
 *
 * - a **datum** — `beneficiary.family_name` — is what the field-sources JSON
 *   renamed a box to, and it is the answer somebody usually wants: one
 *   question fills every box on every form that names it.
 * - a **box** — `i485.pt1.1_family_name` — is a field nobody has claimed yet.
 *   Wiring a question straight to it is legitimate and fills that one box; the
 *   better door is the CRM's Field sources screen, which renames it so the
 *   next form to ask the same thing is filled too.
 *
 * ─── Two sources, because neither alone is the answer ───────────────────────
 *
 * The catalogue answers "what do the forms print?" and `schema_nodes` answers
 * "what does the system know?", and those are different lists in both
 * directions:
 *
 * - Eighteen declared data are asked and print nowhere yet — `travel.purpose`,
 *   `medical.exam_date`. Reading the catalogue alone made those unpickable
 *   even though questions are wired to them today.
 * - Fifteen hundred box names print and are declared nowhere, which is correct:
 *   they are one form's own name for one box.
 *
 * So the list is the union, with the declared half first and carrying its own
 * label and category. Within the rest, ordered by how many forms print the key:
 * a name three forms share is the one somebody is looking for, and a single box
 * is the long tail.
 *
 * ─── What a question may *not* be wired to ──────────────────────────────────
 *
 * Indexed keys are left out — `beneficiary.address_history[2].city` is the
 * second address's city, which is a *box's* business. A question asks the whole
 * list at once and answers with an array; one keyed at an entry would ask
 * "where did you live before?" as something answerable exactly once, which is
 * the shape `repeat_group` exists to replace. The list itself
 * (`beneficiary.address_history`) is offered instead, and `resolveBindings`
 * refuses the other on the same grounds.
 */
export async function fieldVocabulary(): Promise<VocabularyField[]> {
  const rows = await db
    .select({
      fieldKey: formFieldDefinitions.fieldKey,
      label: formFieldDefinitions.label,
      formCode: formFieldDefinitions.formCode,
    })
    .from(formFieldDefinitions)
    .orderBy(
      asc(formFieldDefinitions.formCode),
      asc(formFieldDefinitions.orderIndex),
    );

  const byKey = new Map<string, VocabularyField>();
  for (const row of rows) {
    // A box that prints one entry of a list; see the note above.
    if (parseIndexedKey(row.fieldKey)) continue;

    const entry = byKey.get(row.fieldKey);
    if (!entry) {
      byKey.set(row.fieldKey, {
        fieldKey: row.fieldKey,
        label: row.label,
        formCodes: [row.formCode],
        category: null,
        isRepeating: false,
      });
      continue;
    }
    // One field printed twice on the same form is still one name in one place.
    if (!entry.formCodes.includes(row.formCode)) {
      entry.formCodes.push(row.formCode);
    }
  }

  const declared = await db
    .select({
      path: schemaNodes.path,
      label: schemaNodes.label,
      category: schemaNodes.category,
      isRepeating: schemaNodes.isRepeating,
    })
    .from(schemaNodes)
    .where(notLike(schemaNodes.path, "%[]%"))
    .orderBy(asc(schemaNodes.orderIndex));

  const shared: VocabularyField[] = declared.map((node) => ({
    fieldKey: node.path,
    label: node.label,
    formCodes: byKey.get(node.path)?.formCodes ?? [],
    category: node.category,
    isRepeating: node.isRepeating,
  }));

  for (const node of declared) byKey.delete(node.path);

  const rest = [...byKey.values()].sort(
    (a, b) =>
      b.formCodes.length - a.formCodes.length ||
      a.fieldKey.localeCompare(b.fieldKey),
  );

  return [...shared, ...rest];
}

// ─── Writing: forms ─────────────────────────────────────────────────────────

export type FormInput = {
  formCode: string;
  title: string;
  description?: string | null;
  /**
   * Who completes the form, when it is not the firm — the instruction a
   * paralegal follows. See `form_definitions.provided_by`.
   */
  providedBy?: string | null;
};

/** Names a form. Platform only. */
export async function addCatalogueForm(input: {
  form: FormInput;
  /**
   * Which practice areas the form is for. Rows in `form_practice_areas`, not a
   * column — a form belongs to several, and nothing reads the first of them.
   * See the table's own note for why this exists beside `case_type_forms`.
   */
  practiceAreaIds?: string[];
}): Promise<CatalogueForm> {
  const { form } = input;

  const existing = await catalogueForm(form.formCode);
  if (existing) {
    throw new BadRequestError(
      `${form.formCode} is already in the catalogue as "${existing.title}"`,
    );
  }

  /*
    And the near-duplicate, which the exact check above cannot see.

    Every field read off a blank is named `<code compacted>.pt2.4a_family_name`
    — `formLocalPrefix` strips the code to letters and digits — so `FL-100` and
    `FL100` are two catalogue entries writing into one namespace. Importing the
    second would rename the first's fields out from under every mapping made
    against them, and `clearGeneratedCatalogue` on either would delete both.

    Unreachable until recently: the old code pattern required a hyphen in a
    fixed place, so no two accepted codes could compact to the same string.
    Loosening it so the product can carry `1040` and `FL-341(E)` is what makes
    this check load-bearing rather than defensive.
  */
  const prefix = formLocalPrefix(form.formCode);
  const clash = (await db.select({ formCode: formDefinitions.formCode }).from(formDefinitions)).find(
    (row) => formLocalPrefix(row.formCode) === prefix,
  );
  if (clash) {
    throw new BadRequestError(
      `${form.formCode} is too close to ${clash.formCode}, which is already catalogued — ignoring punctuation and case they are the same code, and both forms' fields would be stored under "${prefix}". Pick a code that differs by more than a dash.`,
    );
  }

  const [created] = await db
    .insert(formDefinitions)
    .values({
      formCode: form.formCode,
      title: form.title,
      description: form.description ?? null,
      providedBy: form.providedBy ?? null,
    })
    .returning();

  if (input.practiceAreaIds) {
    await setFormPracticeAreas(created.formCode, input.practiceAreaIds);
  }

  return {
    id: created.id,
    formCode: created.formCode,
    title: created.title,
    description: created.description,
    providedBy: created.providedBy,
  };
}

/**
 * Which practice areas a form is for, replaced as a set.
 *
 * A set rather than an add and a remove, because a set is what the picker hands
 * over: the chips on screen are the whole answer, and reconciling them against
 * what is stored is arithmetic every caller would have to get right. The two
 * writes are deliberately not in a transaction — the worst failure is a form
 * showing under fewer areas than intended, which the same screen fixes, and
 * these rows carry nothing but the pairing.
 */
export async function setFormPracticeAreas(
  formCode: string,
  practiceAreaIds: string[],
): Promise<void> {
  await db
    .delete(formPracticeAreas)
    .where(eq(formPracticeAreas.formCode, formCode));

  const areaIds = [...new Set(practiceAreaIds)];
  if (areaIds.length === 0) return;

  await db
    .insert(formPracticeAreas)
    .values(areaIds.map((practiceAreaId) => ({ formCode, practiceAreaId })));
}

/**
 * The practice areas a form says it is for.
 *
 * Deliberately separate from `formFiledOn`, which lists the case types whose
 * filing package names the form. The two answer different questions — what a
 * form is *for*, and what actually files it — and a form is routinely one
 * without being the other, most obviously on the day somebody adds it.
 */
export async function formPracticeAreasOf(
  formCode: string,
): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: practiceAreas.id, name: practiceAreas.name })
    .from(formPracticeAreas)
    .innerJoin(
      practiceAreas,
      eq(formPracticeAreas.practiceAreaId, practiceAreas.id),
    )
    .where(eq(formPracticeAreas.formCode, formCode))
    .orderBy(asc(practiceAreas.name));
}

/**
 * Rewords a form. Platform only.
 *
 * `formCode` is not editable: every value, mapping and filing is keyed by it,
 * so changing it would not rename a form but orphan one.
 */
export async function updateCatalogueForm(input: {
  formDefinitionId: string;
  patch: Partial<Omit<FormInput, "formCode">>;
  /**
   * The whole set, or absent to leave the classification alone. Beside the
   * patch rather than inside it, because these are rows in another table and
   * not a column `.set()` could write.
   */
  practiceAreaIds?: string[];
}): Promise<CatalogueForm> {
  const [updated] = await db
    .update(formDefinitions)
    .set({ ...input.patch, updatedAt: new Date() })
    .where(eq(formDefinitions.id, input.formDefinitionId))
    .returning();

  if (!updated) throw new NotFoundError("Form not found");

  // Absent means "not part of this edit". An empty list means "this form is
  // for nothing in particular", which is a thing somebody may genuinely mean,
  // so the two are told apart rather than both read as "leave it alone".
  if (input.practiceAreaIds) {
    await setFormPracticeAreas(updated.formCode, input.practiceAreaIds);
  }

  return {
    id: updated.id,
    formCode: updated.formCode,
    title: updated.title,
    description: updated.description,
    providedBy: updated.providedBy,
  };
}

/**
 * Removes a form from the catalogue, and its fields with it — a catalogue
 * entry for a form nobody can name is not worth keeping.
 *
 * Nothing touches `case_forms` or the values on them. A form already on a
 * matter stays on it, and what somebody typed into it is part of the record of
 * that matter regardless of what the catalogue later says.
 */
export async function deleteCatalogueForm(input: {
  formDefinitionId: string;
}): Promise<{ formCode: string }> {
  const [deleted] = await db
    .delete(formDefinitions)
    .where(eq(formDefinitions.id, input.formDefinitionId))
    .returning();

  if (!deleted) throw new NotFoundError("Form not found");

  await db
    .delete(formFieldDefinitions)
    .where(eq(formFieldDefinitions.formCode, deleted.formCode));

  // Keyed by code rather than by a foreign key, so nothing removes these for
  // us. Left behind, they would put a deleted form's code back on the Forms
  // list the moment somebody filtered by that practice area.
  await db
    .delete(formPracticeAreas)
    .where(eq(formPracticeAreas.formCode, deleted.formCode));

  return { formCode: deleted.formCode };
}

// ─── Writing: fields ────────────────────────────────────────────────────────

export type FieldInput = {
  /**
   * The node this box prints, chosen from the vocabulary — or omitted, which
   * says "this form's own box, nothing else asks it".
   *
   * Optional because typing it was the last free-text field key in the app and
   * it had exactly one failure mode with no feedback on it: a key one character
   * off matches no question, fills nothing, reports nothing, and the box prints
   * blank inside a filing weeks later. Omitting it now generates a form-local
   * key instead of inviting a guess at a shared one.
   */
  fieldKey?: string;
  label: string;
  partLabel?: string | null;
  type: QuestionnaireQuestionType;
  helpText?: string | null;
  config?: Record<string, unknown>;
  isRequired?: boolean;
  orderIndex?: number;
};

/**
 * Adds a field to a form. Platform only.
 *
 * Giving the field the `fieldKey` an existing question already uses is what
 * makes it fill automatically, with no mapping row at all — see the note at
 * the top of `db/schema/form-fields.ts`.
 */
export async function addCatalogueField(input: {
  formCode: string;
  field: FieldInput;
}): Promise<CatalogueField> {
  const { formCode, field } = input;

  const existing = await catalogueFields(formCode);
  const fieldKey =
    field.fieldKey?.trim() ||
    formLocalKey(formCode, field.label, new Set(existing.map((f) => f.fieldKey)));

  if (existing.some((f) => f.fieldKey === fieldKey)) {
    throw new BadRequestError(`${formCode} already has a field for "${fieldKey}"`);
  }

  const orderIndex =
    field.orderIndex ??
    existing.reduce((max, f) => Math.max(max, f.orderIndex + 1), 0);

  const binding = await bindingFor(fieldKey);

  const [created] = await db
    .insert(formFieldDefinitions)
    .values({
      formCode,
      fieldKey,
      ...binding,
      label: field.label,
      partLabel: field.partLabel ?? null,
      type: field.type,
      orderIndex,
      helpText: field.helpText ?? null,
      config: field.config ?? {},
      isRequired: field.isRequired ?? false,
    })
    .returning();

  return toCatalogueField(created);
}

/**
 * A key for a box that carries no shared datum: the form's own name for it.
 *
 * The same shape extraction produces — `i485.<slug of the label>` — so the two
 * populations stay tellable apart by their first segment, which is the one rule
 * `pdf-field-naming.ts` and the CRM's overlay both read. Suffixed if the form
 * already has that name, because two boxes on a blank genuinely can be labelled
 * the same thing.
 */
function formLocalKey(formCode: string, label: string, taken: Set<string>) {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "field";

  const base = `${formLocalPrefix(formCode)}.${slug}`;
  if (!taken.has(base)) return base;

  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

/**
 * The binding a key resolves to, worked out once at write time.
 *
 * The same rule `bindToSchemaNodes` applies in bulk, so a field added here is
 * bound the moment it exists rather than waiting for the next seed run — and
 * an unresolvable key writes nulls rather than failing, because a form-local
 * name is the ordinary case and not an error.
 */
async function bindingFor(fieldKey: string) {
  const { path, entryIndex } = pathOf(fieldKey);
  const [node] = await db
    .select({ id: schemaNodes.id, isRepeating: schemaNodes.isRepeating })
    .from(schemaNodes)
    .where(eq(schemaNodes.path, path))
    .limit(1);

  return node
    ? { schemaNodeId: node.id, entryIndex: node.isRepeating ? entryIndex : null }
    : { schemaNodeId: null, entryIndex: null };
}

/**
 * Rewords a field. Platform only.
 *
 * `fieldKey` is not editable, for the same reason `formCode` is not: it is the
 * shared vocabulary connecting this field to the question that fills it, and
 * changing it would silently unfill the field rather than rename it.
 */
export async function updateCatalogueField(input: {
  fieldDefinitionId: string;
  patch: Partial<Omit<FieldInput, "fieldKey">>;
}): Promise<CatalogueField> {
  const [updated] = await db
    .update(formFieldDefinitions)
    .set({ ...input.patch, updatedAt: new Date() })
    .where(eq(formFieldDefinitions.id, input.fieldDefinitionId))
    .returning();

  if (!updated) throw new NotFoundError("Field not found");

  return toCatalogueField(updated);
}

/**
 * Removes a field. Platform only.
 *
 * The *value* on any matter's form is left alone. A field dropped from the
 * catalogue stops being printed, but what somebody typed into it is part of
 * the record of that matter — which is why `case_form_field_revisions` keys on
 * the field key rather than on this row.
 */
export async function deleteCatalogueField(input: {
  fieldDefinitionId: string;
}): Promise<{ fieldKey: string }> {
  const [deleted] = await db
    .delete(formFieldDefinitions)
    .where(eq(formFieldDefinitions.id, input.fieldDefinitionId))
    .returning();

  if (!deleted) throw new NotFoundError("Field not found");

  return { fieldKey: deleted.fieldKey };
}

/** Reorders the fields on a form in one write, so a drag lands as one save. */
export async function reorderCatalogueFields(input: {
  formCode: string;
  order: { fieldDefinitionId: string; orderIndex: number }[];
}): Promise<{ updated: number }> {
  if (input.order.length === 0) return { updated: 0 };

  await db.transaction(async (tx) => {
    for (const entry of input.order) {
      await tx
        .update(formFieldDefinitions)
        .set({ orderIndex: entry.orderIndex, updatedAt: new Date() })
        .where(
          and(
            eq(formFieldDefinitions.id, entry.fieldDefinitionId),
            // Scoped to the form so one request cannot reshuffle another's
            // fields by passing ids from two forms at once.
            eq(formFieldDefinitions.formCode, input.formCode),
          ),
        );
    }
  });

  return { updated: input.order.length };
}

const toCatalogueField = (
  row: typeof formFieldDefinitions.$inferSelect,
): CatalogueField => ({
  id: row.id,
  formCode: row.formCode,
  fieldKey: row.fieldKey,
  label: row.label,
  partLabel: row.partLabel,
  type: row.type,
  orderIndex: row.orderIndex,
  helpText: row.helpText,
  config: row.config,
  isRequired: row.isRequired,
  schemaNodeId: row.schemaNodeId,
  entryIndex: row.entryIndex,
});

/**
 * Rename one part of a form, across every field in it.
 *
 * ─── A part is not a row, and that is the whole design ──────────────────────
 *
 * There is no `form_parts` table. A part is the distinct values of
 * `form_field_definitions.part_label` on one form, which is exactly what the
 * extraction gives us and exactly what the screens read. It means a part with
 * no fields cannot be stored — an empty part is not a thing that exists — and
 * it means renaming one is an update over its fields rather than a row edit.
 *
 * Doing it by hand is not an alternative: Part 9 of the I-485 is 172 fields,
 * and a rename half-applied is one part that has become two.
 *
 * Three rules:
 *
 * - **`from` may be null, `to` may not.** The unlabelled part is the fields an
 *   extraction could not place, and naming them is ordinary work. Un-naming a
 *   part is not — it would move fields into that same unplaceable pile.
 * - **It refuses to merge.** Renaming onto a part the form already has would
 *   fold two parts into one, silently, over up to 172 rows and with no way
 *   back. A merge is a real thing somebody might want; it is not a rename, and
 *   it is not this.
 * - **It refuses an empty part.** `from` naming nothing is a 404 rather than a
 *   no-op, because the caller believes it is renaming something.
 */
export async function renameFormPart({
  formCode,
  from,
  to,
}: {
  formCode: string;
  from: string | null;
  to: string;
}): Promise<{ formCode: string; from: string | null; to: string; fields: number }> {
  const partIs = (label: string | null) =>
    label === null
      ? isNull(formFieldDefinitions.partLabel)
      : eq(formFieldDefinitions.partLabel, label);

  if (from === to) {
    throw new BadRequestError(`${to} is already what that part is called.`);
  }

  /*
    Whether the form has a part by that name at all.

    Both halves of the union, because both are real: a part usually exists
    because its fields say so, and a described-but-empty part exists because it
    has a row. Renaming either is legitimate, and renaming *onto* either is the
    merge this refuses.
  */
  const partExists = async (label: string | null) => {
    const [field] = await db
      .select({ id: formFieldDefinitions.id })
      .from(formFieldDefinitions)
      .where(and(eq(formFieldDefinitions.formCode, formCode), partIs(label)))
      .limit(1);
    if (field) return true;
    if (label === null) return false;

    const [row] = await db
      .select({ id: formParts.id })
      .from(formParts)
      .where(and(eq(formParts.formCode, formCode), eq(formParts.partLabel, label)))
      .limit(1);
    return Boolean(row);
  };

  if (!(await partExists(from))) {
    throw new NotFoundError(
      from === null
        ? `${formCode} has no unlabelled fields to name.`
        : `${formCode} has no part called "${from}".`,
    );
  }

  if (await partExists(to)) {
    throw new BadRequestError(
      `${formCode} already has a part called "${to}". Renaming onto it would merge the two, which cannot be undone.`,
    );
  }

  const moved = await db
    .update(formFieldDefinitions)
    .set({ partLabel: to })
    .where(and(eq(formFieldDefinitions.formCode, formCode), partIs(from)))
    .returning({ id: formFieldDefinitions.id });

  // The part's own row travels with it, so a renamed part keeps its
  // description. Nothing to move when the part was never described, and
  // nothing to move for the unlabelled part, which has no row by design.
  if (from !== null) {
    await db
      .update(formParts)
      .set({ partLabel: to, updatedAt: new Date() })
      .where(
        and(eq(formParts.formCode, formCode), eq(formParts.partLabel, from)),
      );
  }

  return { formCode, from, to, fields: moved.length };
}

/**
 * Name a part, or describe one that already exists.
 *
 * One operation for both, because they are the same write: `form_parts` holds
 * a part's description and, by existing, a part that has no fields yet. Adding
 * a part with a description and adding a description to a part are the same
 * row arriving.
 *
 * It does not require the part to have fields — that is the point. What it
 * refuses is a second row for a part that already has one, which is the update
 * path rather than the create path.
 */
export async function upsertFormPart({
  formCode,
  partLabel,
  description,
}: {
  formCode: string;
  partLabel: string;
  description?: string | null;
}) {
  const [row] = await db
    .insert(formParts)
    .values({ formCode, partLabel, description: description ?? null })
    .onConflictDoUpdate({
      target: [formParts.formCode, formParts.partLabel],
      set: { description: description ?? null, updatedAt: new Date() },
    })
    .returning();

  return row!;
}

/**
 * Remove a part.
 *
 * Only an empty one. A part with fields in it is deleted by deleting those
 * fields, one at a time and each with its own confirmation — a single control
 * that takes 172 field definitions off a government form with one press is not
 * a control this catalogue should have.
 *
 * Removing the row of a part that still has fields would also do nothing
 * useful: the part would carry on existing, derived from its fields, having
 * silently lost its description.
 */
export async function deleteFormPart({
  formCode,
  partLabel,
}: {
  formCode: string;
  partLabel: string;
}) {
  const held = await db
    .select({ id: formFieldDefinitions.id })
    .from(formFieldDefinitions)
    .where(
      and(
        eq(formFieldDefinitions.formCode, formCode),
        eq(formFieldDefinitions.partLabel, partLabel),
      ),
    )
    .limit(1);

  if (held.length > 0) {
    throw new BadRequestError(
      `"${partLabel}" still has fields in it. Remove them first — a part is deleted by emptying it.`,
    );
  }

  const [removed] = await db
    .delete(formParts)
    .where(
      and(eq(formParts.formCode, formCode), eq(formParts.partLabel, partLabel)),
    )
    .returning({ partLabel: formParts.partLabel });

  if (!removed) {
    throw new NotFoundError(`${formCode} has no part called "${partLabel}".`);
  }

  return removed;
}
