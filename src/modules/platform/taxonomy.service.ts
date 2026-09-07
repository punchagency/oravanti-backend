import { and, asc, count, eq, ilike, notInArray, or, sql } from "drizzle-orm";

import { systemDb } from "../../db/client";
import type { CaseFormRole } from "../../db/schema/case-forms";
import { caseTypeForms } from "../../db/schema/case-type-forms";
import { formDefinitions } from "../../db/schema/form-fields";
import type { CaseTypeJurisdiction } from "../../db/schema/practice-area-case-types";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../db/schema/practice-area-subcategories";
import { practiceAreas } from "../../db/schema/practice-areas";
import { questionnaires } from "../../db/schema/questionnaires";
import type { TaxonomyStatus } from "../../db/schema/taxonomy-status";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../utils/error/app-error";
import {
  caseTypeBlockers,
  practiceAreaBlockers,
  refuseIfBlocked,
  subcategoryBlockers,
} from "./taxonomy-blockers";

/*
  The taxonomy, as the CRM walks it.

  ─── Why this is its own file ───────────────────────────────────────────────

  `platform.service.ts` is about the form catalogue: what a form asks and where
  each answer prints. This is about which *case types* file which forms and ask
  which questionnaires — a different subject that happens to be maintained from
  the same app. Keeping them apart is what lets either be read without the
  other.

  ─── Everything here reads `systemDb` ───────────────────────────────────────

  For the same reason the rest of the tier does: the taxonomy and
  `case_type_forms` carry no `organization_id`, so a tenant connection has
  nothing to scope them by and its `app.current_org_id` would only get in the
  way. A platform request opens no tenant connection, so `db` would resolve
  here anyway — naming `systemDb` is the difference between a reader knowing
  that and assuming it.

  ─── Pagination is not optional ─────────────────────────────────────────────

  8 practice areas, 57 subcategories, 687 case types. The middle number is why
  the CRM shows subcategories as a level rather than flattening: Immigration
  alone holds around 150 case types, and a flat list of those is a page nobody
  reads. Every list below takes `page` and `limit` and reports a total, in the
  shape the rest of the API already uses.
*/

/** The page shape every list in this file returns. */
export type Paged<T> = {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};

export type PageParams = { page?: number; limit?: number; search?: string };

/**
 * Clamps what a caller asked for into what the database will be asked.
 *
 * A `limit` of 0 pages forever and a limit of 10,000 defeats the point, so
 * both ends are pinned. 25 is the default because it fills a screen without
 * needing one.
 */
const resolvePage = (params: PageParams) => {
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? 25)));
  return { page, limit, offset: (page - 1) * limit };
};

const paged = <T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): Paged<T> => ({
  data,
  pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
});

/** `%term%`, with the caller's own wildcards escaped so a `%` searches for one. */
const contains = (term: string) =>
  `%${term.trim().replace(/([%_\\])/g, "\\$1")}%`;

// ─── Level 1: practice areas ────────────────────────────────────────────────

/**
 * The eight practice areas, each with the size of what is under it.
 *
 * The counts are the point of the screen: "Immigration Law — 7 subcategories,
 * 152 case types" tells an operator where the work is before they click into
 * it.
 */
export async function listPracticeAreas(params: PageParams = {}) {
  const { page, limit, offset } = resolvePage(params);
  const where = params.search
    ? ilike(practiceAreas.name, contains(params.search))
    : undefined;

  const [rows, [totals]] = await Promise.all([
    systemDb
      .select({
        id: practiceAreas.id,
        name: practiceAreas.name,
        description: practiceAreas.description,
        status: practiceAreas.status,
        subcategoryCount: sql<number>`count(distinct ${practiceAreaSubcategories.id})::int`,
        caseTypeCount: sql<number>`count(distinct ${practiceAreaCaseTypes.id})::int`,
      })
      .from(practiceAreas)
      .leftJoin(
        practiceAreaSubcategories,
        eq(practiceAreaSubcategories.practiceAreaId, practiceAreas.id),
      )
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.subcategoryId, practiceAreaSubcategories.id),
      )
      .where(where)
      .groupBy(practiceAreas.id)
      .orderBy(asc(practiceAreas.name))
      .limit(limit)
      .offset(offset),
    systemDb.select({ total: count() }).from(practiceAreas).where(where),
  ]);

  return paged(rows, totals?.total ?? 0, page, limit);
}

// ─── Level 2: subcategories ─────────────────────────────────────────────────

export async function listSubcategories(
  practiceAreaId: string,
  params: PageParams = {},
) {
  const { page, limit, offset } = resolvePage(params);

  const [area] = await systemDb
    .select({ id: practiceAreas.id, name: practiceAreas.name })
    .from(practiceAreas)
    .where(eq(practiceAreas.id, practiceAreaId))
    .limit(1);
  if (!area) throw new NotFoundError("Practice area not found");

  const where = and(
    eq(practiceAreaSubcategories.practiceAreaId, practiceAreaId),
    params.search
      ? ilike(practiceAreaSubcategories.name, contains(params.search))
      : undefined,
  );

  const [rows, [totals]] = await Promise.all([
    systemDb
      .select({
        id: practiceAreaSubcategories.id,
        code: practiceAreaSubcategories.code,
        name: practiceAreaSubcategories.name,
        description: practiceAreaSubcategories.description,
        status: practiceAreaSubcategories.status,
        caseTypeCount: sql<number>`count(${practiceAreaCaseTypes.id})::int`,
      })
      .from(practiceAreaSubcategories)
      .leftJoin(
        practiceAreaCaseTypes,
        eq(practiceAreaCaseTypes.subcategoryId, practiceAreaSubcategories.id),
      )
      .where(where)
      .groupBy(practiceAreaSubcategories.id)
      .orderBy(asc(practiceAreaSubcategories.name))
      .limit(limit)
      .offset(offset),
    systemDb
      .select({ total: count() })
      .from(practiceAreaSubcategories)
      .where(where),
  ]);

  return { practiceArea: area, ...paged(rows, totals?.total ?? 0, page, limit) };
}

// ─── Level 3: case types ────────────────────────────────────────────────────

/**
 * The leaves of one subcategory, each saying whether it has been set up yet.
 *
 * `formCount` and `questionnaireCount` are what an operator is actually
 * scanning for: of 687 case types, the ones Oravanti has configured are a
 * small minority, and the list is unreadable if it does not say which.
 */
export async function listCaseTypes(
  subcategoryId: string,
  params: PageParams = {},
) {
  const { page, limit, offset } = resolvePage(params);

  const [subcategory] = await systemDb
    .select({
      id: practiceAreaSubcategories.id,
      name: practiceAreaSubcategories.name,
      practiceAreaId: practiceAreas.id,
      practiceAreaName: practiceAreas.name,
    })
    .from(practiceAreaSubcategories)
    .innerJoin(
      practiceAreas,
      eq(practiceAreas.id, practiceAreaSubcategories.practiceAreaId),
    )
    .where(eq(practiceAreaSubcategories.id, subcategoryId))
    .limit(1);
  if (!subcategory) throw new NotFoundError("Subcategory not found");

  const where = and(
    eq(practiceAreaCaseTypes.subcategoryId, subcategoryId),
    params.search
      ? ilike(practiceAreaCaseTypes.name, contains(params.search))
      : undefined,
  );

  const [rows, [totals]] = await Promise.all([
    systemDb
      .select({
        id: practiceAreaCaseTypes.id,
        code: practiceAreaCaseTypes.code,
        name: practiceAreaCaseTypes.name,
        jurisdiction: practiceAreaCaseTypes.jurisdiction,
        description: practiceAreaCaseTypes.description,
        status: practiceAreaCaseTypes.status,
        /*
          Correlated subqueries rather than two more left joins: joining both
          would multiply the rows against each other, so a case type with 6
          forms and 2 questionnaires would report 12 of each.
        */
        formCount: sql<number>`(
          select count(*)::int from ${caseTypeForms}
          where ${caseTypeForms.caseTypeId} = ${practiceAreaCaseTypes.id}
        )`,
        questionnaireCount: sql<number>`(
          select count(*)::int from ${questionnaires}
          where ${questionnaires.caseTypeId} = ${practiceAreaCaseTypes.id}
        )`,
      })
      .from(practiceAreaCaseTypes)
      .where(where)
      .orderBy(asc(practiceAreaCaseTypes.name))
      .limit(limit)
      .offset(offset),
    systemDb
      .select({ total: count() })
      .from(practiceAreaCaseTypes)
      .where(where),
  ]);

  return { subcategory, ...paged(rows, totals?.total ?? 0, page, limit) };
}

// ─── One case type: its package and its questionnaires ──────────────────────

/**
 * Everything the CRM shows on a case type: where it sits, what it files, and
 * what it asks.
 *
 * Not paginated, and deliberately: a filing package is six forms and a case
 * type has at most two questionnaires — one `intake`, one `case`, which the
 * unique constraint on `questionnaires` guarantees. Paging six rows would be
 * ceremony.
 */
export async function getCaseType(caseTypeId: string) {
  const [caseType] = await systemDb
    .select({
      id: practiceAreaCaseTypes.id,
      code: practiceAreaCaseTypes.code,
      name: practiceAreaCaseTypes.name,
      jurisdiction: practiceAreaCaseTypes.jurisdiction,
      caseNumberPrefix: practiceAreaCaseTypes.caseNumberPrefix,
      description: practiceAreaCaseTypes.description,
      status: practiceAreaCaseTypes.status,
      subcategoryId: practiceAreaSubcategories.id,
      subcategoryName: practiceAreaSubcategories.name,
      practiceAreaId: practiceAreas.id,
      practiceAreaName: practiceAreas.name,
    })
    .from(practiceAreaCaseTypes)
    .innerJoin(
      practiceAreaSubcategories,
      eq(practiceAreaSubcategories.id, practiceAreaCaseTypes.subcategoryId),
    )
    .innerJoin(
      practiceAreas,
      eq(practiceAreas.id, practiceAreaSubcategories.practiceAreaId),
    )
    .where(eq(practiceAreaCaseTypes.id, caseTypeId))
    .limit(1);
  if (!caseType) throw new NotFoundError("Case type not found");

  const [forms, questionnaireRows] = await Promise.all([
    /*
      Left-joined to the catalogue so a package can name a form nobody has
      catalogued yet: the row is real and `defaultPackageFor` will put it on a
      matter, so hiding it here would make the CRM disagree with the app. A
      null title is the CRM's cue to say so.
    */
    systemDb
      .select({
        formCode: caseTypeForms.formCode,
        role: caseTypeForms.role,
        orderIndex: caseTypeForms.orderIndex,
        title: formDefinitions.title,
      })
      .from(caseTypeForms)
      .leftJoin(
        formDefinitions,
        eq(formDefinitions.formCode, caseTypeForms.formCode),
      )
      .where(eq(caseTypeForms.caseTypeId, caseTypeId))
      .orderBy(asc(caseTypeForms.orderIndex), asc(caseTypeForms.formCode)),
    systemDb
      .select({
        id: questionnaires.id,
        stage: questionnaires.stage,
        title: questionnaires.title,
        description: questionnaires.description,
      })
      .from(questionnaires)
      .where(eq(questionnaires.caseTypeId, caseTypeId)),
  ]);

  return {
    caseType,
    forms,
    /*
      Returned by stage rather than as a list, because the two are not
      interchangeable and the CRM shows them as two tabs: `intake` is asked
      before there is a matter, `case` after. Either may be absent, and absent
      is what the tab offers to create.
    */
    questionnaires: {
      intake: questionnaireRows.find((q) => q.stage === "intake") ?? null,
      case: questionnaireRows.find((q) => q.stage === "case") ?? null,
    },
  };
}

// ─── Writing a case type's package ──────────────────────────────────────────

/**
 * Puts a form on a case type's package, or changes the role it holds there.
 *
 * The form must be one Oravanti has catalogued. A code typed by hand that no
 * catalogue matches would go on every matter of that type and print nothing —
 * the same failure the firm's Add form dialog was changed to make impossible.
 */
export async function setCaseTypeForm(params: {
  caseTypeId: string;
  formCode: string;
  role: CaseFormRole;
}) {
  const { caseTypeId, formCode, role } = params;

  const [caseType] = await systemDb
    .select({ id: practiceAreaCaseTypes.id, name: practiceAreaCaseTypes.name })
    .from(practiceAreaCaseTypes)
    .where(eq(practiceAreaCaseTypes.id, caseTypeId))
    .limit(1);
  if (!caseType) throw new NotFoundError("Case type not found");

  const [form] = await systemDb
    .select({ formCode: formDefinitions.formCode })
    .from(formDefinitions)
    .where(eq(formDefinitions.formCode, formCode))
    .limit(1);
  if (!form) throw new NotFoundError("Form not found in the catalogue");

  // Appended at the end of the package. Order is presentation, and the CRM has
  // a reorder call for when it matters.
  const [{ next }] = await systemDb
    .select({ next: sql<number>`coalesce(max(${caseTypeForms.orderIndex}), -1) + 1` })
    .from(caseTypeForms)
    .where(eq(caseTypeForms.caseTypeId, caseTypeId));

  const [row] = await systemDb
    .insert(caseTypeForms)
    .values({ caseTypeId, formCode, role, orderIndex: next })
    .onConflictDoUpdate({
      target: [caseTypeForms.caseTypeId, caseTypeForms.formCode],
      set: { role, updatedAt: new Date() },
    })
    .returning();

  return { caseType, form: row };
}

export async function removeCaseTypeForm(caseTypeId: string, formCode: string) {
  const [row] = await systemDb
    .delete(caseTypeForms)
    .where(
      and(
        eq(caseTypeForms.caseTypeId, caseTypeId),
        eq(caseTypeForms.formCode, formCode),
      ),
    )
    .returning();

  if (!row) throw new NotFoundError("That form is not on this case type");
  return row;
}

/**
 * Rewrites the package's order.
 *
 * Takes the whole list rather than a from/to pair: a partial reorder has to
 * decide what happens to the codes it did not mention, and every answer to
 * that is a rule somebody has to remember. A complete list has no such
 * question, so it is required to be complete.
 */
export async function reorderCaseTypeForms(
  caseTypeId: string,
  formCodes: string[],
) {
  const current = await systemDb
    .select({ formCode: caseTypeForms.formCode })
    .from(caseTypeForms)
    .where(eq(caseTypeForms.caseTypeId, caseTypeId));

  if (current.length === 0) throw new NotFoundError("Case type not found");

  const have = new Set(current.map((row) => row.formCode));
  const given = new Set(formCodes);

  if (given.size !== formCodes.length) {
    throw new BadRequestError("The same form is listed twice");
  }
  if (given.size !== have.size || [...have].some((code) => !given.has(code))) {
    throw new BadRequestError(
      "The order must list every form on this case type, and no others",
    );
  }

  /*
    Sequential, not `Promise.all`. `order_index` is not unique, so a race would
    not error — it would silently interleave, and the package would come back
    in an order nobody asked for. The lists here are six rows long.
  */
  for (const [index, formCode] of formCodes.entries()) {
    await systemDb
      .update(caseTypeForms)
      .set({ orderIndex: index, updatedAt: new Date() })
      .where(
        and(
          eq(caseTypeForms.caseTypeId, caseTypeId),
          eq(caseTypeForms.formCode, formCode),
        ),
      );
  }

  return { caseTypeId, formCodes };
}

/**
 * The catalogue, for the picker that adds a form to a package.
 *
 * Paginated like everything else, and it excludes what is already on the case
 * type: a picker that offers what you have is a picker that mostly offers
 * mistakes.
 */
export async function listFormsForCaseType(
  caseTypeId: string,
  params: PageParams = {},
) {
  const { page, limit, offset } = resolvePage(params);

  const onPackage = (
    await systemDb
      .select({ formCode: caseTypeForms.formCode })
      .from(caseTypeForms)
      .where(eq(caseTypeForms.caseTypeId, caseTypeId))
  ).map((row) => row.formCode);

  const where = and(
    onPackage.length
      ? notInArray(formDefinitions.formCode, onPackage)
      : undefined,
    // Code or title: an operator looking for the affidavit of support knows it
    // as "I-864" on some days and as its name on others.
    params.search
      ? or(
          ilike(formDefinitions.formCode, contains(params.search)),
          ilike(formDefinitions.title, contains(params.search)),
        )
      : undefined,
  );

  const [rows, [totals]] = await Promise.all([
    systemDb
      .select({
        id: formDefinitions.id,
        formCode: formDefinitions.formCode,
        title: formDefinitions.title,
      })
      .from(formDefinitions)
      .where(where)
      .orderBy(asc(formDefinitions.formCode))
      .limit(limit)
      .offset(offset),
    systemDb.select({ total: count() }).from(formDefinitions).where(where),
  ]);

  return paged(rows, totals?.total ?? 0, page, limit);
}

/**
 * How big the taxonomy is, for the overview's tiles.
 *
 * A summary, so it is not paginated — there is nothing to page through, and
 * the alternative (asking for one row of each list and reading its total) would
 * be three round trips to render three numbers.
 */
export async function taxonomyCounts() {
  const [[areas], [subcategories], [caseTypes], [configured]] = await Promise.all([
    systemDb.select({ total: count() }).from(practiceAreas),
    systemDb.select({ total: count() }).from(practiceAreaSubcategories),
    systemDb.select({ total: count() }).from(practiceAreaCaseTypes),
    // Case types with a package on them. The gap from `caseTypes` is the work
    // outstanding, which is the number an operator actually wants.
    systemDb
      .select({ total: sql<number>`count(distinct ${caseTypeForms.caseTypeId})::int` })
      .from(caseTypeForms),
  ]);

  return {
    practiceAreas: areas?.total ?? 0,
    subcategories: subcategories?.total ?? 0,
    caseTypes: caseTypes?.total ?? 0,
    caseTypesWithForms: configured?.total ?? 0,
  };
}

// ─── Writing the taxonomy ───────────────────────────────────────────────────
//
// The CMS is the source of truth for all three levels.
// `practice-area-taxonomy.seed.ts` remains the bootstrap — it writes the
// initial 8 / 57 / 687 — and everything after that happens here: the same two
// doors `aos-case-questionnaire.seed.ts` describes for the field vocabulary.
//
// ─── One rule about `code`, stated once ─────────────────────────────────────
//
// A subcategory's and a case type's `code` is settable at creation and never
// after. It is half of a unique key, the seeds find their targets by it, and a
// case type's `caseNumberPrefix` is stamped into every matter number already
// issued. Renaming is what `name` is for; `code` is the handle other things
// hold. The update inputs below simply do not carry it.

/** The fields a person can change on any node after it exists. */
type NodePatch = {
  name?: string;
  description?: string | null;
  status?: TaxonomyStatus;
};

const touched = <T extends object>(patch: T) => ({
  ...patch,
  updatedAt: new Date(),
});

/**
 * Refuses a patch that would change nothing.
 *
 * Not pedantry: without it an empty PATCH bumps `updatedAt` and files an audit
 * event saying the node changed, which is a false entry somebody later has to
 * read past.
 */
const requirePatch = (patch: object) => {
  if (Object.keys(patch).length === 0) {
    throw new BadRequestError("Nothing to change");
  }
};

// ── Practice areas ──────────────────────────────────────────────────────────

/** One practice area, with what it says about itself and how big it is. */
export async function getPracticeArea(id: string) {
  const [area] = await systemDb
    .select({
      id: practiceAreas.id,
      name: practiceAreas.name,
      description: practiceAreas.description,
      status: practiceAreas.status,
      createdAt: practiceAreas.createdAt,
      updatedAt: practiceAreas.updatedAt,
    })
    .from(practiceAreas)
    .where(eq(practiceAreas.id, id))
    .limit(1);
  if (!area) throw new NotFoundError("Practice area not found");

  const [counts] = await systemDb
    .select({
      subcategories: sql<number>`count(distinct ${practiceAreaSubcategories.id})::int`,
      caseTypes: sql<number>`count(distinct ${practiceAreaCaseTypes.id})::int`,
    })
    .from(practiceAreaSubcategories)
    .leftJoin(
      practiceAreaCaseTypes,
      eq(practiceAreaCaseTypes.subcategoryId, practiceAreaSubcategories.id),
    )
    .where(eq(practiceAreaSubcategories.practiceAreaId, id));

  return {
    ...area,
    subcategoryCount: counts?.subcategories ?? 0,
    caseTypeCount: counts?.caseTypes ?? 0,
  };
}

export async function createPracticeArea(input: {
  name: string;
  description?: string | null;
}) {
  const [row] = await systemDb
    .insert(practiceAreas)
    .values({ name: input.name, description: input.description ?? null })
    /*
      The unique constraint on `name` is what makes this safe to press twice.
      `onConflictDoNothing` then returns no row, which is the signal to say the
      name is taken rather than to report a create that did not happen.
    */
    .onConflictDoNothing({ target: practiceAreas.name })
    .returning();

  if (!row) {
    throw new ConflictError("A practice area with that name already exists");
  }
  return row;
}

export async function updatePracticeArea(id: string, patch: NodePatch) {
  requirePatch(patch);

  const [row] = await systemDb
    .update(practiceAreas)
    .set(touched(patch))
    .where(eq(practiceAreas.id, id))
    .returning();

  if (!row) throw new NotFoundError("Practice area not found");
  return row;
}

export async function deletePracticeArea(id: string) {
  const area = await getPracticeArea(id);
  refuseIfBlocked("practice area", await practiceAreaBlockers(id));

  await systemDb.delete(practiceAreas).where(eq(practiceAreas.id, id));
  return area;
}

// ── Subcategories ───────────────────────────────────────────────────────────

export async function getSubcategory(id: string) {
  const [subcategory] = await systemDb
    .select({
      id: practiceAreaSubcategories.id,
      code: practiceAreaSubcategories.code,
      name: practiceAreaSubcategories.name,
      description: practiceAreaSubcategories.description,
      status: practiceAreaSubcategories.status,
      practiceAreaId: practiceAreas.id,
      practiceAreaName: practiceAreas.name,
      caseTypeCount: sql<number>`(
        select count(*)::int from ${practiceAreaCaseTypes}
        where ${practiceAreaCaseTypes.subcategoryId} = ${practiceAreaSubcategories.id}
      )`,
    })
    .from(practiceAreaSubcategories)
    .innerJoin(
      practiceAreas,
      eq(practiceAreas.id, practiceAreaSubcategories.practiceAreaId),
    )
    .where(eq(practiceAreaSubcategories.id, id))
    .limit(1);

  if (!subcategory) throw new NotFoundError("Subcategory not found");
  return subcategory;
}

export async function createSubcategory(input: {
  practiceAreaId: string;
  code: string;
  name: string;
  description?: string | null;
}) {
  const [area] = await systemDb
    .select({ id: practiceAreas.id, name: practiceAreas.name })
    .from(practiceAreas)
    .where(eq(practiceAreas.id, input.practiceAreaId))
    .limit(1);
  if (!area) throw new NotFoundError("Practice area not found");

  const [row] = await systemDb
    .insert(practiceAreaSubcategories)
    .values({
      practiceAreaId: input.practiceAreaId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
    })
    .onConflictDoNothing({
      target: [
        practiceAreaSubcategories.practiceAreaId,
        practiceAreaSubcategories.code,
      ],
    })
    .returning();

  if (!row) {
    throw new ConflictError(
      `${area.name} already has a subcategory with the code "${input.code}"`,
    );
  }
  return { subcategory: row, practiceArea: area };
}

export async function updateSubcategory(id: string, patch: NodePatch) {
  requirePatch(patch);

  const [row] = await systemDb
    .update(practiceAreaSubcategories)
    .set(touched(patch))
    .where(eq(practiceAreaSubcategories.id, id))
    .returning();

  if (!row) throw new NotFoundError("Subcategory not found");
  return row;
}

export async function deleteSubcategory(id: string) {
  const subcategory = await getSubcategory(id);
  refuseIfBlocked("subcategory", await subcategoryBlockers(id));

  await systemDb
    .delete(practiceAreaSubcategories)
    .where(eq(practiceAreaSubcategories.id, id));
  return subcategory;
}

// ── Case types ──────────────────────────────────────────────────────────────

export async function createCaseType(input: {
  subcategoryId: string;
  code: string;
  name: string;
  caseNumberPrefix: string;
  jurisdiction: CaseTypeJurisdiction;
  description?: string | null;
}) {
  const [subcategory] = await systemDb
    .select({
      id: practiceAreaSubcategories.id,
      name: practiceAreaSubcategories.name,
    })
    .from(practiceAreaSubcategories)
    .where(eq(practiceAreaSubcategories.id, input.subcategoryId))
    .limit(1);
  if (!subcategory) throw new NotFoundError("Subcategory not found");

  const [row] = await systemDb
    .insert(practiceAreaCaseTypes)
    .values({
      subcategoryId: input.subcategoryId,
      code: input.code,
      name: input.name,
      caseNumberPrefix: input.caseNumberPrefix,
      jurisdiction: input.jurisdiction,
      description: input.description ?? null,
    })
    .onConflictDoNothing({
      target: [practiceAreaCaseTypes.subcategoryId, practiceAreaCaseTypes.code],
    })
    .returning();

  if (!row) {
    throw new ConflictError(
      `${subcategory.name} already has a case type with the code "${input.code}"`,
    );
  }
  return { caseType: row, subcategory };
}

export async function updateCaseType(
  id: string,
  patch: NodePatch & {
    caseNumberPrefix?: string;
    jurisdiction?: CaseTypeJurisdiction;
  },
) {
  requirePatch(patch);

  const [row] = await systemDb
    .update(practiceAreaCaseTypes)
    .set(touched(patch))
    .where(eq(practiceAreaCaseTypes.id, id))
    .returning();

  if (!row) throw new NotFoundError("Case type not found");
  return row;
}

export async function deleteCaseType(id: string) {
  const detail = await getCaseType(id);
  refuseIfBlocked("case type", await caseTypeBlockers(id));

  await systemDb
    .delete(practiceAreaCaseTypes)
    .where(eq(practiceAreaCaseTypes.id, id));
  return detail.caseType;
}
