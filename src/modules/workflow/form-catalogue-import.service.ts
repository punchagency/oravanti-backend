/**
 * Write a form's catalogue from what was read off its blank.
 *
 * This is what `src/db/seeds/form-pdf-catalogue.seed.ts` was, with the two
 * files it read taken away. Both of them were local storage, and both are gone:
 *
 *   - `<code>.form-fields.json`, which the extractor wrote and this loaded. It
 *     is now produced in memory by `form-extraction.service.ts` and passed
 *     straight in. A copy is still written to object storage beside the blank —
 *     the record of what was read, on the date it was read — but nothing ever
 *     reads it back. A file that is loaded as well as written is a second
 *     source of truth waiting to disagree, which is exactly what the old
 *     hand-written `FORMS` constant was.
 *
 *   - `<code>.field-sources.json`, the bulk door: a list of pairs saying which
 *     of a form's boxes hold a *shared* datum rather than the form's own name
 *     for a box. That claim has not gone anywhere — it is the whole mechanism
 *     by which an answer reaches a form — it has moved to where it was always
 *     also editable, `form_field_definitions.field_key`, and it now **carries
 *     itself forward** across editions rather than being retyped. See
 *     `carriedForward` below, which is the part of this file that matters.
 *
 * ─── Two doors onto the same claim, and which one wins ──────────────────────
 *
 * A generated key is form-local: `i485.pt1.1_family_name` says "Part 1, item 1,
 * Family Name on the I-485" and claims nothing more. A curated key —
 * `beneficiary.family_name` — claims much more: that this is the same datum the
 * questionnaire asks for and five other forms print, which is what makes
 * population automatic. `form-population.service.ts` matches on that key alone,
 * so the claim is the entire mechanism: no curated key on a box means the box
 * prints blank no matter how many answers the client gave.
 *
 * Only a person can make that claim, and there is now one place to make it —
 * the CRM's mapper — plus one place it is inherited from, which is the same
 * claim made about the previous edition of the same form.
 *
 * **An existing mapping wins.** If somebody has already pointed
 * `beneficiary.family_name` at `Pt1Line1_FamilyName`, an import leaves that box
 * alone and does not add a second row for it — without that rule the two would
 * collide on the one-datum-per-box constraint and the row that knows less would
 * survive.
 *
 * ─── Why an import is planned before it is applied ──────────────────────────
 *
 * The old arrangement got its review from a pull request: the extraction was
 * committed, and somebody read the diff before it reached anyone's matter. That
 * was worth something real and it is not a thing to drop silently along with
 * the file. `planImport` is the replacement — the same write, described and not
 * performed, so the CRM can show what an upload would do to a form every firm
 * in the deployment files. `applyImport` is what an operator confirms.
 */

import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { db } from "../../db/client";
import { formEditions, formPdfFieldMappings } from "../../db/schema/form-editions";
import { formFieldDefinitions } from "../../db/schema/form-fields";
import type { FormEdition } from "../../db/schema/form-editions";
import { formLocalPrefix } from "./pdf-field-naming";
import type { Extraction, ExtractedField } from "./form-extraction.service";

/** What an import would do, or did. */
export type ImportPlan = {
  formCode: string;
  editionDate: string;
  /** Fields this extraction produces that the catalogue does not have. */
  added: string[];
  /** Fields the catalogue has for this form that the extraction no longer produces. */
  removed: string[];
  /** Fields whose label, part, type or order would change. */
  changed: { fieldKey: string; was: string; now: string }[];
  /**
   * Boxes whose curated datum was inherited from the previous edition, because
   * the box has the same name on both and somebody already said what it holds.
   */
  carriedForward: { pdfFieldName: string; fieldKey: string }[];
  /**
   * Boxes an existing mapping already speaks for, left exactly as they are.
   * Named rather than counted: each is somebody's decision this import chose
   * not to overrule.
   */
  deferredToMapping: string[];
  /** How many boxes the blank has, and how many the catalogue will cover. */
  boxes: number;
  fields: number;
};

/**
 * The datum each box carried on the previous edition of this form.
 *
 * ─── Why this exists at all ─────────────────────────────────────────────────
 *
 * USCIS reflows a form between editions and the AcroForm names move with it —
 * that is why mappings are keyed per edition. But they do not *all* move. Most
 * boxes keep their name across an edition, and every one of those already has
 * an answer to "what does this hold?" that a person worked out by hand. On the
 * six catalogued forms that is 252 decisions. Making somebody redo them because
 * USCIS changed a filing address would guarantee that a new edition is worse
 * wired than the one it replaced, which is the opposite of what an edition is
 * for.
 *
 * ─── What counts as a decision worth carrying ───────────────────────────────
 *
 * A key that binds to a `schema_node` — that is the tier's own answer to "does
 * this box carry a shared datum?", the same column the mapper paints green from
 * and the coverage bar counts. A form-local key is not carried: it is what the
 * extractor would have produced anyway, and carrying it would pin the new
 * edition's keys to the old edition's part numbering.
 *
 * The prefix check beside it is not a second rule but the same one for a
 * database that has not been bound yet: `seed-schema-nodes` binds, and until it
 * runs every `schema_node_id` is null. Without the fallback, importing into an
 * unbound database would silently discard every curated key on the form.
 */
const carriedForward = async (formCode: string, before: string) => {
  const [previous] = await db
    .select({ id: formEditions.id })
    .from(formEditions)
    .where(
      and(eq(formEditions.formCode, formCode), lt(formEditions.editionDate, before)),
    )
    .orderBy(desc(formEditions.editionDate))
    .limit(1);

  if (!previous) return new Map<string, string>();

  const prefix = `${formLocalPrefix(formCode)}.`;
  const rows = await db
    .select({
      pdfFieldName: formPdfFieldMappings.pdfFieldName,
      fieldKey: formPdfFieldMappings.fieldKey,
      schemaNodeId: formFieldDefinitions.schemaNodeId,
    })
    .from(formPdfFieldMappings)
    .leftJoin(
      formFieldDefinitions,
      and(
        eq(formFieldDefinitions.formCode, formCode),
        eq(formFieldDefinitions.fieldKey, formPdfFieldMappings.fieldKey),
      ),
    )
    .where(eq(formPdfFieldMappings.formEditionId, previous.id));

  return new Map(
    rows
      .filter(
        (row) => row.schemaNodeId !== null || !row.fieldKey.startsWith(prefix),
      )
      .map((row) => [row.pdfFieldName, row.fieldKey] as const),
  );
};

/**
 * The extraction with every inherited claim applied to it.
 *
 * A rename, not a second row: the field keeps the printed label, the part, the
 * type and the page order the extraction gave it, and only its key changes. The
 * two can therefore never drift, which is the failure the old hand-written
 * `FORMS` constant had.
 */
const applyCarriedKeys = (
  fields: ExtractedField[],
  carried: Map<string, string>,
) =>
  fields.map((field) => {
    // Any one of a choice's boxes is enough to identify the field: they are one
    // question and share a key, so the first box that was wired names the datum
    // for all of them.
    const inherited = field.mappings
      .map((m) => carried.get(m.pdfFieldName))
      .find(Boolean);
    return inherited ? { ...field, fieldKey: inherited } : field;
  });

/**
 * What is already written down for this form and edition.
 *
 * Read once and shared by the plan and the apply, so the two cannot describe
 * different worlds.
 */
const currentState = async (formCode: string, editionId: string) => {
  const [existingFields, existingMappings] = await Promise.all([
    db
      .select({
        fieldKey: formFieldDefinitions.fieldKey,
        label: formFieldDefinitions.label,
        partLabel: formFieldDefinitions.partLabel,
        type: formFieldDefinitions.type,
      })
      .from(formFieldDefinitions)
      .where(eq(formFieldDefinitions.formCode, formCode)),
    db
      .select({
        fieldKey: formPdfFieldMappings.fieldKey,
        pdfFieldName: formPdfFieldMappings.pdfFieldName,
      })
      .from(formPdfFieldMappings)
      .where(eq(formPdfFieldMappings.formEditionId, editionId)),
  ]);

  return { existingFields, existingMappings };
};

/**
 * Boxes somebody has already spoken for, which this import must not overrule.
 *
 * A mapping whose key this extraction does not produce is a decision made in
 * the CRM, and it outranks a machine-derived twin that knows only which box it
 * came from. Any one of a choice's boxes being claimed is enough to defer the
 * whole field: a curated key owning part of a question and a generated key
 * owning the rest would give the form two half-answers.
 */
const claimedBoxes = (
  existingMappings: { fieldKey: string; pdfFieldName: string }[],
  cataloguedKeys: Set<string>,
) => {
  const claimed = new Map<string, string>();
  for (const row of existingMappings) {
    if (!cataloguedKeys.has(row.fieldKey)) {
      claimed.set(row.pdfFieldName, row.fieldKey);
    }
  }
  return claimed;
};

const describe = (f: { label: string; partLabel: string | null; type: string }) =>
  `${f.partLabel ?? "no part"} · ${f.type} · ${f.label}`;

/** What an import would do, without doing any of it. */
export const planImport = async (
  edition: FormEdition,
  extraction: Extraction,
): Promise<ImportPlan> => {
  const { formCode, editionDate } = edition;
  const carried = await carriedForward(formCode, editionDate);
  const fields = applyCarriedKeys(extraction.fields, carried);
  const cataloguedKeys = new Set(fields.map((f) => f.fieldKey));

  const { existingFields, existingMappings } = await currentState(
    formCode,
    edition.id,
  );
  const claimed = claimedBoxes(existingMappings, cataloguedKeys);

  const before = new Map(existingFields.map((f) => [f.fieldKey, f]));
  const added: string[] = [];
  const changed: ImportPlan["changed"] = [];
  const deferredToMapping: string[] = [];

  for (const field of fields) {
    const claimant = field.mappings
      .map((m) => claimed.get(m.pdfFieldName))
      .find(Boolean);
    if (claimant) {
      deferredToMapping.push(`${field.label} → ${claimant}`);
      continue;
    }

    const was = before.get(field.fieldKey);
    if (!was) {
      added.push(field.fieldKey);
    } else if (describe(was) !== describe(field)) {
      changed.push({
        fieldKey: field.fieldKey,
        was: describe(was),
        now: describe(field),
      });
    }
  }

  return {
    formCode,
    editionDate,
    added,
    // A field the catalogue holds that this blank has no box for. Reported, not
    // deleted: it may be a curated field waiting to be pointed at a box, and
    // removing one silently is how a datum stops printing with no trace.
    removed: existingFields
      .filter((f) => !cataloguedKeys.has(f.fieldKey))
      .map((f) => f.fieldKey),
    changed,
    carriedForward: [...carried].map(([pdfFieldName, fieldKey]) => ({
      pdfFieldName,
      fieldKey,
    })),
    deferredToMapping,
    boxes: extraction.fields.reduce((n, f) => n + f.mappings.length, 0),
    fields: cataloguedKeys.size,
  };
};

/**
 * Write the catalogue.
 *
 * Idempotent, and upserts on the natural keys — running it twice over the same
 * blank produces the same rows. What it does not do is delete: a field the
 * extraction no longer produces stays, and is reported by `planImport` as
 * `removed` so somebody can decide. `clearGeneratedCatalogue` is the deliberate
 * version of that.
 */
export const applyImport = async (
  edition: FormEdition,
  extraction: Extraction,
): Promise<ImportPlan> => {
  const plan = await planImport(edition, extraction);
  const { formCode } = edition;

  const carried = await carriedForward(formCode, edition.editionDate);
  const fields = applyCarriedKeys(extraction.fields, carried);
  const cataloguedKeys = new Set(fields.map((f) => f.fieldKey));

  const { existingMappings } = await currentState(formCode, edition.id);
  const claimed = claimedBoxes(existingMappings, cataloguedKeys);

  /*
    One datum can occupy boxes in two different parts — the I-130 asks for the
    date of marriage in Part 2 and again in Part 4, and once both are called
    `marriage.date` they are one field printed twice. The first box wins the
    label and the page order, because a field can only sit in one place on the
    Forms page; every box still gets its mapping row below.
  */
  const written = new Set<string>();

  for (const field of fields) {
    if (field.mappings.some((m) => claimed.has(m.pdfFieldName))) continue;

    if (!written.has(field.fieldKey)) {
      await db
        .insert(formFieldDefinitions)
        .values({
          formCode,
          fieldKey: field.fieldKey,
          label: field.label,
          partLabel: field.partLabel,
          type: field.type,
          orderIndex: field.orderIndex,
          config: field.config,
        })
        .onConflictDoUpdate({
          // The platform tier's unique index. A firm's own row for the same key
          // is a different row and must not be touched — see the three-tier
          // note in src/db/schema/form-fields.ts.
          target: [formFieldDefinitions.formCode, formFieldDefinitions.fieldKey],
          set: {
            label: field.label,
            partLabel: field.partLabel,
            type: field.type,
            orderIndex: field.orderIndex,
            config: field.config,
            updatedAt: new Date(),
          },
        });
      written.add(field.fieldKey);
    }

    // One row per box. Keyed on the box rather than on the field, because a
    // choice has several rows sharing a field key and only the box is unique
    // across all of them.
    for (const mapping of field.mappings) {
      await db
        .insert(formPdfFieldMappings)
        .values({
          formEditionId: edition.id,
          fieldKey: field.fieldKey,
          pdfFieldName: mapping.pdfFieldName,
          fieldValue: mapping.value,
        })
        .onConflictDoUpdate({
          target: [
            formPdfFieldMappings.formEditionId,
            formPdfFieldMappings.pdfFieldName,
          ],
          set: {
            fieldKey: field.fieldKey,
            fieldValue: mapping.value,
            updatedAt: new Date(),
          },
        });
    }
  }

  return plan;
};

/**
 * Remove a form's generated catalogue, leaving curated rows alone.
 *
 * The escape hatch for a bad extraction: an import updates rows and adds new
 * ones but never removes one a fixed extractor no longer produces. Generated
 * keys are recognisable — they start with the form's own compacted code — so
 * the two tiers can be told apart without a flag column.
 */
export const clearGeneratedCatalogue = async (formCode: string) => {
  const prefix = `${formLocalPrefix(formCode)}.pt`;
  const generated = await db
    .select({ fieldKey: formFieldDefinitions.fieldKey })
    .from(formFieldDefinitions)
    .where(
      and(
        eq(formFieldDefinitions.formCode, formCode),
        sql`${formFieldDefinitions.fieldKey} like ${`${prefix}%`}`,
      ),
    );

  if (generated.length === 0) return 0;
  const keys = generated.map((row) => row.fieldKey);

  await db
    .delete(formPdfFieldMappings)
    .where(inArray(formPdfFieldMappings.fieldKey, keys));

  await db
    .delete(formFieldDefinitions)
    .where(
      and(
        eq(formFieldDefinitions.formCode, formCode),
        inArray(formFieldDefinitions.fieldKey, keys),
      ),
    );

  return keys.length;
};

/** Curated fields on this form that no box prints — each a decision waiting. */
export const unmappedCuratedFields = async (
  formCode: string,
  editionId: string,
) => {
  const [curated, mapped] = await Promise.all([
    db
      .select({ fieldKey: formFieldDefinitions.fieldKey })
      .from(formFieldDefinitions)
      .where(
        and(
          eq(formFieldDefinitions.formCode, formCode),
          isNotNull(formFieldDefinitions.schemaNodeId),
        ),
      ),
    db
      .select({ fieldKey: formPdfFieldMappings.fieldKey })
      .from(formPdfFieldMappings)
      .where(eq(formPdfFieldMappings.formEditionId, editionId)),
  ]);

  const printed = new Set(mapped.map((m) => m.fieldKey));
  return curated.map((c) => c.fieldKey).filter((key) => !printed.has(key));
};
