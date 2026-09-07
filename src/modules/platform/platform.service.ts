import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";

import { systemDb } from "../../db/client";
import {
  formEditions,
  formPdfFieldMappings,
} from "../../db/schema/form-editions";
import {
  formDefinitions,
  formFieldDefinitions,
  formPracticeAreas,
} from "../../db/schema/form-fields";
import { platformAdmins } from "../../db/schema/platform-admins";
import { caseTypeForms } from "../../db/schema/case-type-forms";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../db/schema/practice-area-subcategories";
import { practiceAreas } from "../../db/schema/practice-areas";
import { NotFoundError } from "../../utils/error/app-error";

/**
 * The platform operator's own record.
 *
 * `systemDb` rather than `db`, and explicitly so: `platform_admins` has no
 * tenant column, so there is nothing for a tenant connection to scope it by.
 * The `db` Proxy would resolve to `systemDb` here anyway — a platform request
 * holds no organization, so no tenant connection is opened — but naming it is
 * the difference between a reader knowing that and assuming it.
 */
export async function getPlatformAdmin(userId: string) {
  const [operator] = await systemDb
    .select({
      id: platformAdmins.id,
      userId: platformAdmins.userId,
      firstName: platformAdmins.firstName,
      lastName: platformAdmins.lastName,
      email: platformAdmins.email,
      avatarUrl: platformAdmins.avatarUrl,
      createdAt: platformAdmins.createdAt,
    })
    .from(platformAdmins)
    .where(eq(platformAdmins.userId, userId))
    .limit(1);

  // Unreachable behind `requirePlatformAdmin`, which has already found this
  // row. Thrown rather than returning null so the type stays non-nullable for
  // every caller instead of each one re-checking what the guard settled.
  if (!operator) throw new NotFoundError("Platform admin not found");

  return operator;
}

/**
 * The catalogue with each form's edition and how much of it is wired up.
 *
 * Three questions the CRM's overview has to answer at once — what forms exist,
 * how many of their fields print somewhere, and which of them are about to stop
 * being accepted — and answering them per form would be a request per row.
 *
 * The edition is the part that is easy to leave out and expensive to. USCIS
 * rejects a filing made on a superseded edition, and the transition is a date
 * on a row in `form_editions` that nothing otherwise surfaces: on the day it
 * passes, every mapping for that form still resolves and the PDF still renders,
 * from a blank USCIS will no longer take. That is a silent failure with a
 * knowable date, which is exactly the kind worth putting on a dashboard.
 */
export async function listCatalogueOverview(
  params: {
    page?: number;
    limit?: number;
    search?: string;
    /** Narrow to the forms some case type under this practice area files. */
    practiceAreaId?: string;
  } = {},
) {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? 25)));

  /*
    Which practice areas file each form, and the filter that reads it.

    Run before the page query rather than beside it, because a practice-area
    filter has to narrow the page itself — filtering after would leave the row
    count and the page saying different things.

    The whole of `case_type_forms` in one go, and deliberately not narrowed to
    this page: it is one row per form per package, a few hundred at the size
    this catalogue is ever going to be, against a round trip per row.
  */
  const packages = await systemDb
    .select({
      formCode: caseTypeForms.formCode,
      practiceAreaId: practiceAreas.id,
      practiceArea: practiceAreas.name,
    })
    .from(caseTypeForms)
    .innerJoin(
      practiceAreaCaseTypes,
      eq(caseTypeForms.caseTypeId, practiceAreaCaseTypes.id),
    )
    .innerJoin(
      practiceAreaSubcategories,
      eq(practiceAreaCaseTypes.subcategoryId, practiceAreaSubcategories.id),
    )
    .innerJoin(
      practiceAreas,
      eq(practiceAreaSubcategories.practiceAreaId, practiceAreas.id),
    );

  /*
    And what each form says it is *for*, which is the other half of the same
    question and is answered earlier.

    A package is the better answer — it is which matters actually file the form
    — but it is empty for exactly as long as a form is new, so a form somebody
    catalogued this morning would belong to nothing and appear under no filter.
    These rows are set when the form is named. Neither half is authoritative
    over the other; the badges and the filter read the union.
  */
  const tagged = await systemDb
    .select({
      formCode: formPracticeAreas.formCode,
      practiceAreaId: practiceAreas.id,
      practiceArea: practiceAreas.name,
    })
    .from(formPracticeAreas)
    .innerJoin(
      practiceAreas,
      eq(formPracticeAreas.practiceAreaId, practiceAreas.id),
    );

  const areasByForm = new Map<string, { id: string; name: string }[]>();
  const caseTypesByForm = new Map<string, number>();

  // Counted over packages only: this is "how many matter types file it", and a
  // form tagged Immigration that nothing files yet files nothing.
  for (const row of packages) {
    caseTypesByForm.set(
      row.formCode,
      (caseTypesByForm.get(row.formCode) ?? 0) + 1,
    );
  }

  for (const row of [...tagged, ...packages]) {
    const areas = areasByForm.get(row.formCode) ?? [];
    // One badge per area however many rows name it — a practice area with four
    // case types that all file the I-485, and the tag beside them, is one.
    if (!areas.some((a) => a.id === row.practiceAreaId)) {
      areas.push({ id: row.practiceAreaId, name: row.practiceArea });
      areasByForm.set(row.formCode, areas);
    }
  }

  const filedUnder = params.practiceAreaId
    ? [
        ...new Set(
          [...tagged, ...packages]
            .filter((row) => row.practiceAreaId === params.practiceAreaId)
            .map((row) => row.formCode),
        ),
      ]
    : null;

  /*
    Code or title. An operator looking for the affidavit of support knows it as
    "I-864" on some days and by its name on others, and a search that only
    matched one of those would look broken on the other.
  */
  // Wildcards in the caller's own term are escaped, so searching for "%" finds
  // a literal one rather than every form in the catalogue.
  const term = params.search?.trim().replace(/([%_\\])/g, "\\$1");
  const where = and(
    term
      ? or(
          ilike(formDefinitions.formCode, `%${term}%`),
          ilike(formDefinitions.title, `%${term}%`),
        )
      : undefined,
    // An empty list is a real answer — a practice area whose case types file
    // nothing — and `inArray` with no values is invalid SQL, so it is spelled
    // as the falsehood it means rather than left to the query builder.
    filedUnder
      ? filedUnder.length
        ? inArray(formDefinitions.formCode, filedUnder)
        : sql`false`
      : undefined,
  );

  const [forms, fields, editions, [totals]] = await Promise.all([
    systemDb
      .select({
        id: formDefinitions.id,
        formCode: formDefinitions.formCode,
        title: formDefinitions.title,
        description: formDefinitions.description,
        // Flagged on the list, because it is the property that changes what a
        // firm can do with the form rather than what it reads.
        providedBy: formDefinitions.providedBy,
      })
      .from(formDefinitions)
      .where(where)
      .orderBy(asc(formDefinitions.formCode))
      .limit(limit)
      .offset((page - 1) * limit),
    systemDb
      .select({
        formCode: formFieldDefinitions.formCode,
        total: count(),
      })
      .from(formFieldDefinitions)
      .groupBy(formFieldDefinitions.formCode),
    systemDb
      .select()
      .from(formEditions)
      .orderBy(asc(formEditions.formCode), desc(formEditions.editionDate)),
    systemDb.select({ total: count() }).from(formDefinitions).where(where),
  ]);

  const totalByForm = new Map(fields.map((row) => [row.formCode, row.total]));

  /*
    The edition in force today, by the same rule `form-pdf.service` files on.

    Deliberately the same rule and deliberately not the same code: that one
    reads a single form inside a request that is about to render it, this one
    reads every form at once for a dashboard. Sharing it would mean a query per
    row. What must not drift is the *rule*, so it is stated here in full —
    accepted window, newest edition wins — rather than approximated.
  */
  const today = new Date().toISOString().slice(0, 10);
  const editionByForm = new Map<string, (typeof editions)[number]>();
  for (const edition of editions) {
    if (edition.acceptedFrom > today) continue;
    if (edition.acceptedUntil && edition.acceptedUntil < today) continue;
    // Ordered newest-first, so the first one through wins the overlap.
    if (!editionByForm.has(edition.formCode)) {
      editionByForm.set(edition.formCode, edition);
    }
  }

  /*
    The two lookups above are deliberately not narrowed to this page. They are
    grouped counts keyed by form code — a row per form across a catalogue of
    tens — so filtering them would cost another round trip to save nothing
    measurable.

    The mapping count below *is* narrowed, and for a different reason than
    volume: it can only be asked once the in-force edition is known, because
    the condition it applies is per form.
  */
  const total = totals?.total ?? 0;

  const inForce = forms.flatMap((form) => {
    const edition = editionByForm.get(form.formCode);
    return edition ? [{ editionId: edition.id, formCode: form.formCode }] : [];
  });

  /*
    How much of this form prints — which is not how many of its boxes are
    mapped.

    Extraction gives *every* box a field and a mapping, so counting mapping
    rows reports a form nobody has wired as complete: the I-130 read 438 of 438
    with a green bar while it printed 33 data. What makes a box print is that
    its field names a datum somebody asked for — which is now a foreign key
    (`form_field_definitions.schema_node_id`) rather than a rule about the
    shape of a string, so the list, the mapper's overlay and population all
    read the same column and cannot disagree about what "done" means.

    Restricted to the edition in force, because that is how the mappings are
    keyed: a mapping belongs to the blank it was read off, so last year's
    edition keeps its own and a new one starts empty. And distinct on the node,
    because a choice is one mapping row per option and a datum can print into
    several boxes — a field with three options mapped is one datum that prints,
    not three.
  */
  const mapped = inForce.length
    ? await systemDb
        .select({
          formCode: formFieldDefinitions.formCode,
          mapped: countDistinct(formFieldDefinitions.schemaNodeId),
        })
        .from(formPdfFieldMappings)
        .innerJoin(
          formFieldDefinitions,
          eq(formFieldDefinitions.fieldKey, formPdfFieldMappings.fieldKey),
        )
        .where(
          or(
            ...inForce.map(({ editionId, formCode }) =>
              and(
                eq(formPdfFieldMappings.formEditionId, editionId),
                eq(formFieldDefinitions.formCode, formCode),
                isNotNull(formFieldDefinitions.schemaNodeId),
              ),
            ),
          ),
        )
        .groupBy(formFieldDefinitions.formCode)
    : [];

  const mappedByForm = new Map(mapped.map((row) => [row.formCode, row.mapped]));

  const data = forms.map((form) => {
    const edition = editionByForm.get(form.formCode) ?? null;

    return {
      ...form,
      /**
       * Where this form is filed from. Derived from `case_type_forms` — see
       * `formFiledOn` for why a form has no owning practice area of its own.
       * Empty means catalogued but on nobody's package yet, which is a real
       * state and worth showing rather than hiding behind a default.
       */
      practiceAreas: areasByForm.get(form.formCode) ?? [],
      caseTypeCount: caseTypesByForm.get(form.formCode) ?? 0,
      fieldCount: totalByForm.get(form.formCode) ?? 0,
      /**
       * Data that print into a box on the edition currently in force — not
       * boxes that have a mapping, which is nearly all of them on any form.
       * See the query above.
       *
       * The gap from `fieldCount` is the work left: boxes nobody has yet
       * decided a datum for. It reopens when a new edition arrives, which is
       * the honest answer rather than a reassuring one.
       */
      mappedCount: edition ? (mappedByForm.get(form.formCode) ?? 0) : 0,
      edition: edition
        ? {
            editionDate: edition.editionDate,
            /** Null while the edition is current; a date is a deadline. */
            acceptedUntil: edition.acceptedUntil,
          }
        : null,
    };
  });

  return {
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Where a form is filed — the case types whose package names it.
 *
 * `case_type_forms` is the only link between a form and the taxonomy, and this
 * reads it in the direction the case type's own page does not: that page asks
 * "what does this case type file", and this asks "what files this form".
 *
 * Deliberately derived rather than stored. A form has no owning practice area
 * column, because it has no owning practice area: the I-864 is filed on a
 * family adjustment and on an employment one, and the moment a form is filed
 * from two places a single owner is a lie somebody has to maintain. Where a
 * form belongs is the set of packages that name it, and that set is one table.
 *
 * Archived case types are included, and marked. An operator looking at the
 * I-693 needs to know a retired case type still refers to it — that is the
 * thing they are about to break — where a firm picking a case type must not
 * see it at all. Two different questions, so `isOffered` does not apply here.
 */
export async function formFiledOn(formCode: string) {
  return systemDb
    .select({
      caseTypeId: practiceAreaCaseTypes.id,
      caseType: practiceAreaCaseTypes.name,
      caseTypeStatus: practiceAreaCaseTypes.status,
      subcategoryId: practiceAreaSubcategories.id,
      subcategory: practiceAreaSubcategories.name,
      practiceAreaId: practiceAreas.id,
      practiceArea: practiceAreas.name,
      role: caseTypeForms.role,
      orderIndex: caseTypeForms.orderIndex,
    })
    .from(caseTypeForms)
    .innerJoin(
      practiceAreaCaseTypes,
      eq(caseTypeForms.caseTypeId, practiceAreaCaseTypes.id),
    )
    .innerJoin(
      practiceAreaSubcategories,
      eq(practiceAreaCaseTypes.subcategoryId, practiceAreaSubcategories.id),
    )
    .innerJoin(
      practiceAreas,
      eq(practiceAreaSubcategories.practiceAreaId, practiceAreas.id),
    )
    .where(eq(caseTypeForms.formCode, formCode))
    .orderBy(
      asc(practiceAreas.name),
      asc(practiceAreaSubcategories.name),
      asc(practiceAreaCaseTypes.name),
    );
}

/**
 * Every case type in the deployment, for the pickers.
 *
 * The taxonomy is global reference data — one row per case type, identical for
 * every firm — so there is nothing to scope this by and no firm's list to
 * confuse it with.
 */
export async function listCaseTypes() {
  return systemDb
    .select({
      id: practiceAreaCaseTypes.id,
      code: practiceAreaCaseTypes.code,
      name: practiceAreaCaseTypes.name,
      jurisdiction: practiceAreaCaseTypes.jurisdiction,
    })
    .from(practiceAreaCaseTypes)
    .orderBy(asc(practiceAreaCaseTypes.name));
}
