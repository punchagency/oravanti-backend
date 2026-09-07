import { z } from "zod";

import { questionnaireQuestionTypeEnum } from "../../db/schema/enums";

/**
 * What the CRM accepts.
 *
 * These are the firm-facing catalogue schemas from `case-details.validation`,
 * addressed by what they actually operate on. The old ones all began with a
 * `caseId` that was never used to scope the write — it was an access check
 * borrowed from a neighbouring route — and carrying it across would have kept
 * exactly the confusion this move exists to end: a form is not a property of a
 * matter.
 */

/**
 * What a form code may look like — and, more to the point, what it may not.
 *
 * This used to be `^[A-Z]{1,4}-\d{1,4}[A-Z]?$`, which is USCIS's house style
 * written down as a law. It is not one. The product is not only immigration,
 * and that pattern rejects `1040`, `FL-341(E)`, `AOC-CV-100` and `SAPCR` —
 * real codes on real forms in tax, California family law, North Carolina
 * courts and Texas family law respectively.
 *
 * What the *system* actually needs from a code is narrower and has nothing to
 * do with its shape, because the code is not a label. It is the join key:
 * `form_code` is a `text` column in eight tables, matched by value rather than
 * by an id, so it must be
 *
 *   - **stable** — which is why it cannot be edited after creation;
 *   - **path-safe**, because it is a URL segment (`/platform/forms/:formCode`)
 *     and part of an object key (`platform/forms/<code>/<edition>/blank.pdf`);
 *   - **non-empty once compacted**, because `formLocalPrefix` strips it to
 *     letters and digits to name every generated field key.
 *
 * Hence: starts with a letter or digit, then letters, digits and the
 * punctuation a form code actually uses. No slash, no whitespace, no percent —
 * each of those breaks one of the three above rather than merely looking odd.
 *
 * Uniqueness of the *compacted* form is checked in `addCatalogueForm`, not
 * here, because it needs the database. That check is not optional: `FL-100`
 * and `FL100` are two codes this pattern accepts and one prefix, and the old
 * pattern made that collision unreachable by accident.
 */
const formCodeString = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z0-9][A-Z0-9.\-()]{0,23}$/,
    "A form code may use letters, digits, and - . ( ) — up to 24 characters, starting with a letter or digit. No spaces or slashes.",
  );

/**
 * A field key, in either of the two shapes one can take.
 *
 * `beneficiary.date_of_birth` is a datum. `beneficiary.address_history[2].city`
 * is one entry of a repeating one — the second address's city — and the bracket
 * is the grammar `repeat-group.ts` defines, one per key, on the last segment.
 * The pattern used to allow only the first shape, which quietly made every
 * repeating box unaddressable through the CRM.
 */
const fieldKeyString = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9_]+(\.[a-z0-9_]+)*(\[\d+\]\.[a-z0-9_]+)?$/,
    "Expected a field key like beneficiary.date_of_birth, or beneficiary.address_history[2].city for one entry of a list",
  );

// ─── Params ─────────────────────────────────────────────────────────────────

export const formCodeParams = z.object({ formCode: formCodeString });

export const definitionIdParams = z.object({ definitionId: z.string().uuid() });

export const formDefinitionParams = formCodeParams.extend({
  definitionId: z.string().uuid(),
});

export const mappingIdParams = formCodeParams.extend({
  mappingId: z.string().uuid(),
});

export const caseTypeIdParams = z.object({ caseTypeId: z.string().uuid() });

/** Narrows the questions the wiring screen offers to one case type's set. */
export const caseTypeQuery = z.object({
  caseTypeId: z.string().uuid().optional(),
});

/**
 * Narrows a form read to the part the screen is showing.
 *
 * Optional, and an empty string is meaningful: it addresses the part of a form
 * whose fields carry no part label. See `partOf` in the controller.
 */
export const formPartQuery = z.object({
  part: z.string().max(200).optional(),
});

export const formPartAndCaseTypeQuery = formPartQuery.merge(caseTypeQuery);

// ─── Forms ──────────────────────────────────────────────────────────────────

export const addFormBody = z
  .object({
    formCode: formCodeString,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    /** See `updateFormBody`. Almost always absent. */
    providedBy: z.string().trim().max(2000).nullable().optional(),
    /**
     * Which practice areas this form is for. Plural, and that is the point.
     *
     * A *single* owning area would be a lie — the I-864 is filed on a
     * family-based adjustment and on an employment-based one — so these are
     * rows in `form_practice_areas`, and nothing reads the first of them.
     *
     * It is deliberately not a case type. Somebody naming a form knows the
     * practice area immediately and does not yet know which of the 150 matter
     * types under it will file the thing; that decision belongs on the matter
     * type's own page, where the rest of its filing package is visible. So this
     * writes **no** `case_type_forms` row: putting a form on 150 packages
     * because an operator chose "Immigration" is a guess with consequences for
     * every matter opened afterwards.
     *
     * Optional. A form nobody has classified yet is ordinary.
     */
    practiceAreaIds: z.array(z.string().uuid()).max(20).optional(),
  })
  .strict();

export const updateFormBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    /**
     * The practice areas this form is for — the **whole** set, replacing
     * whatever is stored.
     *
     * Absent leaves the classification alone, and an empty array clears it.
     * Those are two different intentions and the picker can express both: a
     * form somebody has decided is for nothing in particular is not the same
     * as a form whose title they came here to fix.
     *
     * Editable, unlike the filing package, because this table has one owner
     * and this is its screen. `case_type_forms` is not offered here for
     * exactly the opposite reason.
     */
    practiceAreaIds: z.array(z.string().uuid()).max(20).optional(),
    /**
     * Who completes the form, when it is not the firm — written as the
     * instruction to follow. Null for almost every form.
     *
     * Setting it takes the form out of every firm filing package and out of
     * every populate run, so it is an operator decision and not a label. See
     * the note on `form_definitions.provided_by`.
     */
    providedBy: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

// ─── Fields ─────────────────────────────────────────────────────────────────

/**
 * A field on a form.
 *
 * `fieldKey` is the shared vocabulary: giving a new field the key an existing
 * question already uses is what makes it fill automatically, with no mapping
 * row at all. See the note at the top of `db/schema/form-fields.ts`.
 *
 * Optional, and its absence is a claim rather than an omission: *this box
 * carries no shared datum*. The service then generates the form's own name for
 * it. Typing the key was the last free-text field key in the app, and it had
 * one failure mode with no feedback on it — a well-formed key naming nothing
 * fills nothing and reports nothing.
 */
export const addFieldBody = z
  .object({
    fieldKey: fieldKeyString.optional(),
    label: z.string().trim().min(1).max(300),
    partLabel: z.string().trim().max(200).nullable().optional(),
    type: z.enum(questionnaireQuestionTypeEnum.enumValues),
    helpText: z.string().trim().max(2000).nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    isRequired: z.boolean().optional(),
    orderIndex: z.number().int().min(0).optional(),
  })
  .strict();

/** `fieldKey` is absent on purpose — changing it unfills the field. */
export const updateFieldBody = addFieldBody
  .omit({ fieldKey: true })
  .partial()
  .strict();

/**
 * Renaming a part.
 *
 * `from` is nullable — the unlabelled part is a real part with a real name of
 * nothing — and `to` is not, because un-naming a part would move its fields
 * into the pile the extraction could not place. See `renameFormPart`.
 */
/** Naming a part, or describing one. The same write either way — see `upsertFormPart`. */
export const savePartBody = z
  .object({
    partLabel: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

/** Which part to remove. On the query string, because a DELETE carries no body. */
export const partLabelQuery = z.object({
  partLabel: z.string().trim().min(1).max(200),
});

export const renamePartBody = z
  .object({
    from: z.string().trim().max(200).nullable(),
    to: z.string().trim().min(1).max(200),
  })
  .strict();

export const reorderFieldsBody = z
  .object({
    order: z
      .array(
        z.object({
          fieldDefinitionId: z.string().uuid(),
          orderIndex: z.number().int().min(0),
        }),
      )
      .min(1)
      .max(1000),
  })
  .strict();

// ─── Field sources: which question fills which field ────────────────────────

export const setFieldMappingBody = z
  .object({
    fieldKey: fieldKeyString,
    sourceQuestionId: z.string().uuid(),
    /** Required by the service when this displaces the shared vocabulary. */
    overrideRationale: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

/**
 * A whole form's field sources, saved at once — the unit the wiring screen
 * works in. A null `sourceQuestionId` clears the mapping.
 */
export const setFieldMappingsBody = z
  .object({
    mappings: z
      .array(
        z.object({
          fieldKey: fieldKeyString,
          sourceQuestionId: z.string().uuid().nullable(),
          overrideRationale: z.string().trim().max(2000).nullable().optional(),
        }),
      )
      .min(1)
      .max(1000),
  })
  .strict();

// ─── PDF boxes: which box on the blank a field prints into ──────────────────

export const pdfMappingBody = z
  .object({
    fieldKey: fieldKeyString,
    pdfFieldName: z.string().trim().min(1).max(500).nullable(),
    /**
     * Which answer marks this box, for a choice. USCIS prints one checkbox per
     * option, so a choice is mapped one option at a time and this says which.
     * Omitted for a text or dropdown field, where the box holds the whole
     * datum.
     */
    fieldValue: z.string().trim().min(1).max(500).nullish(),
  })
  .strict();

// ─── The taxonomy and its packages ──────────────────────────────────────────

/**
 * `page`, `limit` and `search`, for every list the CRM shows.
 *
 * Coerced rather than parsed by hand: a query string carries `"2"`, not `2`,
 * and every list would otherwise repeat the same `Number(...)` with the same
 * chance of `NaN`. The service clamps the range — this only decides the type.
 */
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

/**
 * The catalogue list, which is paged and searched like every other list here
 * and additionally faceted by practice area — the one dimension a form has, and
 * it has it through the packages that name it rather than through a column.
 */
export const formCatalogueQuery = pageQuery.extend({
  practiceAreaId: z.string().uuid().optional(),
});

export const practiceAreaIdParams = z.object({
  practiceAreaId: z.string().uuid(),
});

export const subcategoryIdParams = z.object({
  subcategoryId: z.string().uuid(),
});

export const caseTypeFormParams = caseTypeIdParams.extend({
  formCode: formCodeString,
});

export const setCaseTypeFormBody = z
  .object({
    formCode: formCodeString,
    /*
      Defaulted rather than required. Core is the common case by a wide margin
      — supporting documents are the I-864 and the I-693 and little else — and
      the role can be changed on the row afterwards.
    */
    role: z.enum(["core", "supporting"]).default("core"),
  })
  .strict();

export const reorderCaseTypeFormsBody = z
  .object({
    /** The whole package, in the order it should be filed. See the service. */
    formCodes: z.array(formCodeString).min(1),
  })
  .strict();

// ─── Maintaining the taxonomy ───────────────────────────────────────────────

/**
 * A node's own text, shared by all three levels.
 *
 * `.nullable()` and not just `.optional()`: clearing a description is a real
 * edit, and the two mean different things on a PATCH — omitted is "leave it",
 * null is "there is nothing to say about this".
 */
const nodeDescription = z.string().trim().max(4000).nullable().optional();

/**
 * The taxonomy status, mirrored from `taxonomy_status`.
 *
 * Spelled out rather than derived from the pgEnum so this file stays readable
 * beside the others here; the enum is two values and a test would be heavier
 * than the drift it guards against.
 */
const taxonomyStatus = z.enum(["active", "archived"]);

/**
 * A code, on the two levels that carry one.
 *
 * Lowercase, no spaces, because it is a stable handle rather than a label —
 * the seeds find their targets by it and a rename would strand them.
 */
const nodeCode = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "Expected a code like family-based-immigration",
  );

export const createPracticeAreaBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: nodeDescription,
  })
  .strict();

/*
  `code` is absent from all three update bodies, deliberately.

  It is half of a unique key, the seeds find their targets by it, and a case
  type's `caseNumberPrefix` is already stamped into every matter number issued
  under it. `name` is what a rename changes; `code` is the handle other things
  hold. `.strict()` turns an attempt into a 400 rather than a silent no-op.
*/
export const updateTaxonomyNodeBody = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: nodeDescription,
    status: taxonomyStatus.optional(),
  })
  .strict();

export const createSubcategoryBody = z
  .object({
    code: nodeCode,
    name: z.string().trim().min(1).max(255),
    description: nodeDescription,
  })
  .strict();

export const createCaseTypeBody = z
  .object({
    code: nodeCode,
    name: z.string().trim().min(1).max(255),
    /** Stamped into every matter number issued under this case type. */
    caseNumberPrefix: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .regex(/^[A-Z0-9-]+$/, "Expected an uppercase prefix like AOS or N400"),
    jurisdiction: z.enum(["federal", "state", "federal & state", "varies"]),
    description: nodeDescription,
  })
  .strict();

/** A case type may also change the two fields the other levels do not have. */
export const updateCaseTypeBody = updateTaxonomyNodeBody
  .extend({
    caseNumberPrefix: createCaseTypeBody.shape.caseNumberPrefix.optional(),
    jurisdiction: createCaseTypeBody.shape.jurisdiction.optional(),
  })
  .strict();

// ─── Form editions and their blanks ─────────────────────────────────────────

export const editionParams = formCodeParams.extend({
  editionId: z.string().uuid(),
});

/** ISO date, and the only shape an edition date is ever written in. */
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date like 2026-09-18");

/**
 * A new edition of a form already in the catalogue.
 *
 * `editionDate` is the date printed at the foot of every page, and it is half
 * of the natural key — there is no update body carrying it, for the same reason
 * `code` is not settable on a taxonomy node: the mappings of every box on the
 * blank hang off this row, and changing which edition it claims to be would not
 * rename an edition but mislabel one.
 *
 * `acceptedUntil` null means "no end date set", which is not the same as "in
 * force" — an edition USCIS has announced but not yet started accepting has a
 * null end and a future `acceptedFrom`. `currentEdition` reads both.
 */
export const addEditionBody = z
  .object({
    editionDate: isoDate,
    acceptedFrom: isoDate,
    acceptedUntil: isoDate.nullable().optional(),
    sourceUrl: z.string().trim().url().max(500).nullable().optional(),
    verifiedOn: isoDate.nullable().optional(),
  })
  .strict();

export const updateEditionBody = z
  .object({
    acceptedFrom: isoDate.optional(),
    acceptedUntil: isoDate.nullable().optional(),
    sourceUrl: z.string().trim().url().max(500).nullable().optional(),
    /** When a human last checked this row against uscis.gov. */
    verifiedOn: isoDate.nullable().optional(),
  })
  .strict();
