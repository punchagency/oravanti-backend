import { count, eq, type SQL } from "drizzle-orm";

import { systemDb } from "../../db/client";
import { caseTypeForms } from "../../db/schema/case-type-forms";
import { cases } from "../../db/schema/cases";
import { contractorSpecialties } from "../../db/schema/contractors";
import { caseTypeDocumentRequirements } from "../../db/schema/document-requirements";
import { feeAgreements } from "../../db/schema/fee-agreements";
import { firmPracticeAreas } from "../../db/schema/firm-practice-areas";
import { invoices } from "../../db/schema/invoices";
import { leads } from "../../db/schema/leads";
import { practiceAreaCaseTypes } from "../../db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../db/schema/practice-area-subcategories";
import { questionnaires } from "../../db/schema/questionnaires";
import { staffPracticeAreaCaseTypes } from "../../db/schema/staff-practice-area-case-types";
import { subscriptions } from "../../db/schema/subscriptions";
import { teamPracticeAreaCaseTypes } from "../../db/schema/team-practice-area-case-types";
import { workflowTemplates } from "../../db/schema/workflow";
import { ConflictError } from "../../utils/error/app-error";

/*
  What stands in the way of deleting a taxonomy node.

  ─── Why this file exists at all ────────────────────────────────────────────

  The foreign keys pointing at this taxonomy fall into two groups, and both are
  a reason not to delete — for opposite reasons.

  **The ones that block.** `cases`, `leads`, `invoices`, `subscriptions` and
  `fee_agreements` hold their references with no `onDelete`, so postgres
  refuses the delete outright. Left to the database, that surfaces as a foreign
  key violation: a five-table error string in a toast, naming constraints
  rather than saying "eleven matters are open under this".

  **The ones that cascade, which is worse.** `firm_practice_areas`,
  `workflow_templates`, `staff_practice_area_case_types`,
  `team_practice_area_case_types`, `contractor_specialties`,
  `case_type_document_requirements` and `case_type_forms` all cascade. Deleting
  one practice area would take every firm's workflow templates and staff
  assignments beneath it, silently and with no undo. Nothing in the error path
  would mention it, because there would be no error.

  So the CMS counts first, refuses with the list, and offers archiving instead
  — which is what an operator saying "stop offering this" actually means.
  Deletion is left for the genuine mistake: a node created ten minutes ago that
  nothing has touched.
*/

/** One reason a node cannot be deleted, in the words the CMS shows. */
export type Blocker = {
  /** What holds it, named for a person: "open matters", not "cases". */
  label: string;
  count: number;
};

/**
 * Counts one referencing table.
 *
 * `count()` rather than fetching rows: this asks whether anything at all
 * points here, and the answer for a well-used case type is thousands of rows
 * nobody is going to read.
 */
const tally = async (
  label: string,
  // Drizzle's table types do not share a useful supertype for this, and the
  // alternative is 15 near-identical query blocks. The `where` is built by the
  // caller against the same table it passes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  where: SQL | undefined,
): Promise<Blocker | null> => {
  const [row] = await systemDb.select({ total: count() }).from(table).where(where);
  const total = row?.total ?? 0;
  return total > 0 ? { label, count: total } : null;
};

const present = (results: (Blocker | null)[]) =>
  results.filter((blocker): blocker is Blocker => blocker !== null);

export async function practiceAreaBlockers(id: string) {
  return present(
    await Promise.all([
      tally("subcategories", practiceAreaSubcategories, eq(practiceAreaSubcategories.practiceAreaId, id)),
      tally("firms working in it", firmPracticeAreas, eq(firmPracticeAreas.practiceAreaId, id)),
      tally("subscriptions", subscriptions, eq(subscriptions.practiceAreaId, id)),
      tally("matters", cases, eq(cases.practiceAreaId, id)),
      tally("leads", leads, eq(leads.practiceAreaId, id)),
      tally("invoices", invoices, eq(invoices.practiceAreaId, id)),
      tally("fee agreements", feeAgreements, eq(feeAgreements.practiceAreaId, id)),
    ]),
  );
}

/**
 * A subcategory holds nothing but its case types.
 *
 * Nothing else in the schema references one — matters and leads name the
 * practice area and the case type, and skip the middle. So the only question
 * is whether it is empty.
 */
export async function subcategoryBlockers(id: string) {
  return present(
    await Promise.all([
      tally("case types", practiceAreaCaseTypes, eq(practiceAreaCaseTypes.subcategoryId, id)),
    ]),
  );
}

export async function caseTypeBlockers(id: string) {
  return present(
    await Promise.all([
      tally("matters", cases, eq(cases.caseTypeId, id)),
      tally("leads", leads, eq(leads.caseTypeId, id)),
      tally("questionnaires", questionnaires, eq(questionnaires.caseTypeId, id)),
      tally("workflow templates", workflowTemplates, eq(workflowTemplates.caseTypeId, id)),
      tally("forms on its package", caseTypeForms, eq(caseTypeForms.caseTypeId, id)),
      tally("document requirements", caseTypeDocumentRequirements, eq(caseTypeDocumentRequirements.caseTypeId, id)),
      tally("staff assigned to it", staffPracticeAreaCaseTypes, eq(staffPracticeAreaCaseTypes.caseTypeId, id)),
      tally("teams assigned to it", teamPracticeAreaCaseTypes, eq(teamPracticeAreaCaseTypes.caseTypeId, id)),
      tally("contractors listing it as a specialty", contractorSpecialties, eq(contractorSpecialties.practiceAreaCaseTypeId, id)),
      tally("fee agreements", feeAgreements, eq(feeAgreements.caseTypeId, id)),
    ]),
  );
}

/**
 * Refuses the delete, saying what is in the way and what to do instead.
 *
 * A 409 rather than a 400: nothing about the request is malformed, and the same
 * request would succeed once the node is empty. The metadata carries the
 * counts so the CMS can list them rather than re-deriving a sentence from a
 * message string.
 */
export function refuseIfBlocked(what: string, blockers: Blocker[]) {
  if (blockers.length === 0) return;

  throw new ConflictError(
    `This ${what} is in use, so it cannot be deleted. Archive it instead — everything already filed under it keeps working, and it stops being offered for new matters.`,
    { blockers },
  );
}
