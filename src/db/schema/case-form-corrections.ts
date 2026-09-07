import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { caseForms } from "./case-forms";
import { cases } from "./cases";
import { staff } from "./staff";

/**
 * What the reviewing attorney marked, and what was done about it.
 *
 * ─── Why this is not `case_issues` ─────────────────────────────────────────
 *
 * `case_issues` is what the system noticed — a rule or the AI observing that a
 * document is missing or a deadline is at risk. This is what a *person*
 * noticed, on a specific box of a specific blank, in a review they were asked
 * to do. The two differ in the only ways that matter for a table: an issue is
 * detected and may be dismissed as not applicable, a correction is *raised* and
 * has to be answered; an issue points at a matter, a correction points at a
 * part or a field of one form; an issue's severity is graded, a correction's
 * colour is whatever the attorney reached for.
 *
 * Folding one into the other would mean a paralegal's Forms tab querying a
 * table whose rows are mostly about deadlines, filtered by a source column that
 * would then have to mean two things.
 *
 * ─── A mark is an anchor plus a sentence ───────────────────────────────────
 *
 * The anchor is either a part of the form ("Part 3. Biographic Information") or
 * one field of it, never both and never neither — the check constraint below is
 * that rule, because a mark anchored to nothing cannot be shown on any screen
 * and a mark anchored to two things cannot be resolved once.
 *
 * The sentence is `note`, and it is NOT NULL for the same reason: a coloured
 * dot with no words is a message the person who has to act on it cannot read.
 */

/**
 * Open until somebody says what they changed.
 *
 * There is no "dismissed". A correction an attorney raised and nobody acted on
 * is either still open or was answered — and "answered" includes "you are
 * right, nothing needed changing", which is a resolution with a note saying so.
 * A third state would let a mark leave the queue without anybody writing that
 * sentence.
 */
export const caseFormCorrectionStatusEnum = pgEnum(
  "case_form_correction_status",
  ["open", "resolved"],
);

export type CaseFormCorrectionStatus =
  (typeof caseFormCorrectionStatusEnum.enumValues)[number];

/**
 * The colour the attorney marked it in.
 *
 * Four values rather than free hex, and deliberately *unlabelled* — the product
 * asked for "a red mark or any colour of their choice", which is a request for
 * the attorney's own shorthand, not for a severity scale the app defines and
 * then has to explain. A closed set is what lets both themes render them
 * legibly and what stops a mark being invisible because somebody picked the
 * page's background colour.
 */
export const caseFormCorrectionColorEnum = pgEnum(
  "case_form_correction_color",
  ["red", "amber", "blue", "violet"],
);

export type CaseFormCorrectionColor =
  (typeof caseFormCorrectionColorEnum.enumValues)[number];

export const caseFormCorrections = pgTable(
  "case_form_corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    /**
     * Denormalised from `case_forms` so the matter's whole review is one query.
     * The Forms tab asks "what is still open on this filing?" far more often
     * than it asks about one form.
     */
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    caseFormId: uuid("case_form_id")
      .notNull()
      .references(() => caseForms.id, { onDelete: "cascade" }),

    /** The form's own division, exactly as `form_field_definitions.part_label` spells it. */
    partLabel: text("part_label"),
    /** The datum, matching `case_form_field_values.field_key`. */
    fieldKey: text("field_key"),

    color: caseFormCorrectionColorEnum("color").notNull().default("red"),
    /** What is wrong. Written by the attorney raising it. */
    note: text("note").notNull(),

    status: caseFormCorrectionStatusEnum("status").notNull().default("open"),

    raisedById: uuid("raised_by_id")
      .notNull()
      .references(() => staff.id),
    raisedAt: timestamp("raised_at").notNull().defaultNow(),

    resolvedById: uuid("resolved_by_id").references(() => staff.id),
    resolvedAt: timestamp("resolved_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("case_form_corrections_case_idx").on(t.caseId, t.status),
    index("case_form_corrections_form_idx").on(t.caseFormId),

    // Exactly one anchor. See the note above: neither is unshowable, both is
    // unresolvable.
    check(
      "case_form_corrections_one_anchor",
      sql`(${t.partLabel} IS NULL) <> (${t.fieldKey} IS NULL)`,
    ),

    // Resolved means somebody signed it off; open means nobody has. Kept as a
    // constraint because the two columns are read independently — the tab
    // shows the name, the gate counts the status — and a row where they
    // disagree would make one of those two screens lie.
    check(
      "case_form_corrections_resolution_complete",
      sql`(${t.status} = 'resolved') = (${t.resolvedById} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * The conversation on one mark.
 *
 * The attorney's opening sentence is the correction's own `note`; everything
 * after it is here — what the paralegal changed, the attorney's reply, the
 * reason it was reopened. A thread rather than a single "resolution note"
 * because a correction can go round more than once, and the second pass is
 * exactly the one somebody will want to read later.
 */
export const caseFormCorrectionComments = pgTable(
  "case_form_correction_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    correctionId: uuid("correction_id")
      .notNull()
      .references(() => caseFormCorrections.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => staff.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("case_form_correction_comments_idx").on(t.correctionId)],
);

export type CaseFormCorrection = typeof caseFormCorrections.$inferSelect;
export type NewCaseFormCorrection = typeof caseFormCorrections.$inferInsert;
export type CaseFormCorrectionComment =
  typeof caseFormCorrectionComments.$inferSelect;
