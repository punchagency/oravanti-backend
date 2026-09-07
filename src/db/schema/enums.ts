import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Portal access status, shared by `staff` and `clients`.
 *
 * Declared HERE and not in `src/modules/auth/enums.ts`, where it originally
 * sat, because `drizzle.config.ts` points `schema` at `./src/db/schema` only.
 * A pgEnum declared outside that glob is invisible to drizzle-kit, so it
 * emitted the two columns without ever emitting `CREATE TYPE portal_status`
 * and every generated migration failed with:
 *
 *     type "portal_status" does not exist
 *
 * The other enums in that file are unaffected only because nothing inside the
 * glob references them — the tables that look like they should use them
 * (`user.account_type`, `staff.status`) resolve to separately-declared types
 * with different names. Anything a table in this directory references has to
 * be declared in this directory.
 */
export const portalStatusValues = [
  'none',
  'pending',
  'active',
  'disabled',
] as const;
export type PortalStatus = (typeof portalStatusValues)[number];
export const portalStatusEnum = pgEnum('portal_status', portalStatusValues);

export const filingTypeEnum = pgEnum('filing_type', [
  'I-130',
  'I-485',
  'I-765',
  'I-140',
  'N-400',
  'I-131',
  // Types the mandamus case's own `cases` row (separate from the parent
  // AOS/N-400 matter, see immigration-case-details.ts) can be filed as.
  'MANDAMUS',
]);

export const assignmentTypeEnum = pgEnum('assignment_type', ['internal_team', 'external_contractor']);
export const urgencyLevelEnum = pgEnum('urgency_level', ['normal', 'urgent', 'critical']);
export const assignmentStatusEnum = pgEnum('assignment_status', ['pending', 'active', 'completed', 'cancelled']);

/**
 * How a question is asked, and — because they are the same vocabulary — how a
 * form field is rendered and what kind of datum a schema node is.
 *
 * Declared here rather than in `questionnaires.ts`, where it used to sit,
 * because three tables in this directory now reference it: `questionnaire_questions`,
 * `form_field_definitions` and `schema_nodes`. Leaving it in one of those made
 * the other two import from it, and `schema_nodes` closed the loop into a
 * cycle — `questionnaires` needs `schemaNodes` for its foreign key, and
 * `schema_nodes` needs this enum for its column. A shared enum belongs beside
 * the other shared enums, which is what this file is for.
 *
 * One enum across all three is deliberate: it means the Forms tab, the
 * questionnaire and the CRM's pickers share their renderers instead of keeping
 * three implementations of "a date field" in step.
 */
export const questionnaireQuestionTypeEnum = pgEnum(
  "questionnaire_question_type",
  [
    "short_text",
    "long_text",
    "number",
    "email",
    "phone",
    "date",
    "time",
    "single_choice",
    "multiple_choice",
    "dropdown",
    "rating_scale",
    "file_upload",
    "yes_no",
    "matrix_grid",
    "signature",
    /**
     * A question that answers more than once: its value is a JSON array of
     * objects, and its `config` declares the sub-fields each holds. Address
     * history, employment history, children, prior marriages — every list a
     * USCIS form asks for. See `modules/workflow/repeat-group.ts`.
     */
    "repeat_group",
  ],
);
