import { index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { caseFormRoleEnum } from "./case-forms";
import { practiceAreaCaseTypes } from "./practice-area-case-types";

/**
 * The filing package a case type files, as data.
 *
 * ─── What this replaced ─────────────────────────────────────────────────────
 *
 * Two constants in `case-forms.service.ts` — `ADJUSTMENT_PACKAGE` and
 * `NATURALIZATION_PACKAGE` — chosen by a boolean profile inferred from the
 * matter's workflow template. It worked for the two packages that existed, and
 * it could not grow: a third package meant a third constant, a third boolean,
 * and a deploy. Oravanti sells a maintained catalogue to firms, and "which
 * forms an EB-2 files" is exactly the kind of thing that changes without a
 * release.
 *
 * The inference is gone with them. A matter's package now comes from its own
 * `case_type_id`, which is a column it already had — the workflow template
 * still decides what *happens* on the matter, but no longer has to be
 * interrogated about what gets filed.
 *
 * ─── Oravanti's, like the catalogue it points into ──────────────────────────
 *
 * No `organization_id`. Which forms an adjustment files is a fact about USCIS,
 * not a preference a firm holds, and this table is the case-type half of the
 * same rule the form catalogue states: a form is a government blank, and
 * nobody but the government changes it. Maintained from the CRM at `/platform`
 * behind `requirePlatformAdmin`; every firm reads the same rows.
 *
 * A firm that needs a form this table does not list still adds it to the one
 * matter — `POST /cases/:caseId/forms/:formCode`. That is a decision about the
 * matter, and it does not write here.
 *
 * ─── Why `form_code` and not a foreign key ──────────────────────────────────
 *
 * The same reason `case_forms` and `filing_fee_schedule` use it: the code is
 * the identity a person knows a form by, it is unique in `form_definitions`,
 * and every other table in the form system already joins on it. A uuid here
 * would be the only place that did not.
 */
export const caseTypeForms = pgTable(
  "case_type_forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    caseTypeId: uuid("case_type_id")
      .notNull()
      .references(() => practiceAreaCaseTypes.id, { onDelete: "cascade" }),

    /** e.g. "I-485". Joins to `form_definitions.form_code`. */
    formCode: text("form_code").notNull(),

    /**
     * Whether USCIS issues a receipt for it.
     *
     * The same distinction `case_forms` carries, and the reason it is set here
     * rather than there: a form's role is a property of the package, not of
     * one matter. The I-864 is supporting in every adjustment ever filed.
     */
    role: caseFormRoleEnum("role").notNull().default("core"),

    /**
     * The order the package is assembled and rendered in.
     *
     * Presentation only. Each form is adjudicated on its own clock, and
     * nothing reads this to decide which form "represents" the matter.
     */
    orderIndex: integer("order_index").notNull().default(0),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // A form is on a case type's package or it is not. Listing it twice with
    // two roles would make `defaultPackageFor` non-deterministic.
    unique("case_type_forms_case_type_form_unique").on(t.caseTypeId, t.formCode),
    index("case_type_forms_case_type_idx").on(t.caseTypeId),
  ],
);

export type CaseTypeForm = typeof caseTypeForms.$inferSelect;
export type NewCaseTypeForm = typeof caseTypeForms.$inferInsert;
