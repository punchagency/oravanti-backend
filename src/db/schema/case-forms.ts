import { date, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { cases } from "./cases";
import { organization } from "./auth-schema";

/**
 * One row per form on a matter: what state it is in, what it cost, and what
 * came back.
 *
 * ─── Why the case record was not enough ─────────────────────────────────────
 *
 * A concurrent adjustment filing is not one form. It is an I-130, an I-485, an
 * I-765 and an I-131, plus an I-864 and an I-693 that ride along as supporting
 * documents — six pieces of paper, each with its own edition, its own fee, its
 * own receipt number and its own adjudication.
 *
 * `immigration_case_details.filing_type` was a single enum, and a package does
 * not have a single form. Asking staff to pick one made them answer a question
 * with no true answer, and every reader downstream inherited the fiction: the
 * USCIS median lookup measured whichever form had been picked rather than the
 * one actually running late. The column is migrated into these rows and
 * dropped rather than kept alongside as a second home.
 *
 * The rest was scattered. Drafting progress lived in a workflow task, the
 * receipt number in a `receipt_numbers` jsonb map, the fee was quoted live, the
 * edition check was one step covering every form at once, and the filing date
 * was a single column on the case. Nothing could answer "is the I-765 filed?" —
 * only "is the package filed?" The I-765 is exactly where that distinction
 * matters, because it is routinely approved months before the I-485 it rides
 * with.
 *
 * That the model was half-way there showed in its own inconsistency: receipt
 * numbers were already a per-form map while the filing type was a scalar. This
 * table finishes the thought and takes the map with it — `receipt_numbers` is
 * migrated in and dropped rather than kept alongside as a second home.
 *
 * ─── Scope ─────────────────────────────────────────────────────────────────
 *
 * Facts about the paper, not about the case. Nothing here duplicates a workflow
 * task: the task is the work of preparing the form, this row is the form's
 * standing. A form's *content* belongs to the questionnaire that captures it.
 */

/**
 * Where a form has got to.
 *
 * Deliberately not the task-status vocabulary. A form is not a unit of work —
 * it is not "in review" or "rejected by a colleague", it is drafted, filed,
 * receipted and then adjudicated. `rfe` is a state a form sits in for weeks and
 * is the one most worth seeing at a glance.
 */
export const caseFormStatusEnum = pgEnum("case_form_status", [
  "not_started",
  "in_preparation",
  "ready_to_file",
  "filed",
  "receipted",
  "rfe",
  "approved",
  "denied",
  "withdrawn",
]);

export type CaseFormStatus = (typeof caseFormStatusEnum.enumValues)[number];

/**
 * Whether a form is a filing in its own right or a document supporting one.
 *
 * The distinction is not cosmetic: a core form has its own receipt number and
 * its own adjudication, a supporting document has neither and is approved or
 * refused only as part of the filing it accompanies. Showing an I-864 with an
 * empty receipt-number field forever would read as missing data.
 */
export const caseFormRoleEnum = pgEnum("case_form_role", ["core", "supporting"]);

export type CaseFormRole = (typeof caseFormRoleEnum.enumValues)[number];

export const caseForms = pgTable(
  "case_forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),

    /**
     * e.g. "I-485", "I-130A", "I-864".
     *
     * Free text rather than the `filing_type` enum, for the same reason
     * `form_editions.form_code` is: a package carries forms that are not
     * themselves a kind of case. The two columns must agree, which is why they
     * share the convention rather than one referencing the other.
     */
    formCode: text("form_code").notNull(),
    role: caseFormRoleEnum("role").notNull().default("core"),
    status: caseFormStatusEnum("status").notNull().default("not_started"),

    /** The edition printed on the form actually being filed. */
    editionDate: date("edition_date"),
    /** When this form went to USCIS. Per-form: a package is not always filed in one envelope. */
    filedDate: date("filed_date"),
    /** From the I-797C for this form. Null on a supporting document, which gets none. */
    receiptNumber: text("receipt_number"),
    /**
     * What was actually paid, in cents.
     *
     * Recorded rather than quoted. The fee schedule says what a form costs
     * today; this says what this matter paid, which is the figure that has to
     * reconcile against the invoice and survives a later fee increase.
     */
    feeCents: integer("fee_cents"),

    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    /** One row per form per matter — the same form is never filed twice on one case. */
    unique("case_forms_case_form_unique").on(t.caseId, t.formCode),
    index("case_forms_case_idx").on(t.caseId),
    index("case_forms_organization_idx").on(t.organizationId),
    index("case_forms_status_idx").on(t.status),
  ],
);
