import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth-schema";
import { caseForms } from "./case-forms";
import { questionnaireQuestionTypeEnum } from "./enums";
import { schemaNodes } from "./schema-nodes";
import { staff } from "./staff";

/**
 * ─── Field keys are the whole design ────────────────────────────────────────
 *
 * A `fieldKey` — `beneficiary.date_of_birth`, `petitioner.mailing_address.city`
 * — names a *datum*, not a place on a page. The same key is used by the
 * questionnaire question that asks for it and by every form field that prints
 * it, and that shared vocabulary is what makes population automatic: an answer
 * flows to a form field because both call it the same thing, with no mapping
 * row in between.
 *
 * This is why a date of birth appearing on all six forms of an adjustment
 * package is asked once. Six questions would give six answers and, sooner or
 * later, six spellings — and the spelling is what USCIS matches on.
 *
 * `form_field_mappings` below exists only for the cases the shared vocabulary
 * does not cover — a question whose key was never going to match the field it
 * ought to fill.
 *
 * ─── Everything in this file is the platform's ──────────────────────────────
 *
 * `form_definitions`, `form_field_definitions` and `form_field_mappings` hold
 * one tier of row: Oravanti's. They used to hold three — the platform's, a
 * firm's, and one matter's — with a firm's edit stored as a copy carrying
 * `supersedes_id`. That is gone, and the rule that replaced it is one
 * sentence:
 *
 *   A questionnaire is a conversation with a client, and a firm may extend it.
 *   A form is a government blank, and nobody but the government changes it.
 *
 * So a firm reads this catalogue and writes none of it. It is maintained from
 * the Oravanti CRM (`/platform`), behind `requirePlatformAdmin`. A firm that
 * needs to capture something a form does not ask for adds a *question* — see
 * `questionnaire_sections.scope`, which keeps all three tiers precisely
 * because a questionnaire is the surface a firm is meant to shape.
 *
 * The three tables below therefore carry no `organization_id`, no `case_id`
 * and no `supersedes_id`, and there is no merge step anywhere that reads them.
 * The four tables *after* them — values, versions, revisions — are the
 * opposite: they are one matter's own content, org-scoped and firm-owned.
 * That line, drawn halfway down this file, is the whole permission model.
 */

/**
 * Where a value on a form came from. Recorded per field, because "who said
 * this?" is the first question anyone asks of a form that turns out to be
 * wrong.
 */
export const formFieldValueSourceEnum = pgEnum("form_field_value_source", [
  /** Carried from a questionnaire answer — automatically, or through a mapping. */
  "questionnaire",
  /** Read off the matter itself: the case record, the client, the case details. */
  "case_record",
  /** Typed by a staff member on the form. */
  "manual",
]);

export type FormFieldValueSource =
  (typeof formFieldValueSourceEnum.enumValues)[number];

/**
 * What fields a form has — the catalogue.
 *
 * Exhaustive, not curated. This once held the few dozen boxes per form that
 * carry the matter's data; it now holds every fillable box on the blank —
 * 352 on the I-130, 512 on the I-485 — extracted from the PDF itself by
 * `scripts/extract-form-fields.ts`, because printing a filled PDF needs a
 * catalogue that matches the file it prints into, box for box.
 *
 * One row serves every firm in the deployment: an I-485 has the fields an
 * I-485 has. See the note at the top of this file for why there is no firm
 * tier here and no `supersedes_id` — and for where a firm goes instead.
 */
export const formFieldDefinitions = pgTable(
  "form_field_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** e.g. "I-485". Free text, matching `case_forms.form_code`. */
    formCode: text("form_code").notNull(),
    /** The datum this field prints. See the note at the top of this file. */
    fieldKey: text("field_key").notNull(),
    /**
     * The vocabulary node this field prints, where it prints a shared one.
     *
     * `fieldKey` above is the same claim as a *string*, and it is still what
     * population matches on — this column is that string with a foreign key
     * behind it. Null means the field carries no shared datum: extraction names
     * every box it finds (`i130.pt2.2_uscis_online_account_number`) and most of
     * those are asked by exactly one form, which is a legitimate state and the
     * common one. What null must never mean is "the key was misspelt": that is
     * the case this column exists to make findable, because a well-formed key
     * naming nothing looks identical to one naming something, and the only
     * report of the difference used to be a box printing blank inside a filing.
     */
    schemaNodeId: uuid("schema_node_id").references(() => schemaNodes.id),
    /**
     * Which entry of a repeating node this field prints, counting from 1.
     *
     * Null when the node does not repeat. The node holds the datum once —
     * `beneficiary.address_history[].city` is *the city of an address* — and
     * which address a given box wants is a fact about the form: the I-485
     * prints two, the I-130 prints one. Keeping the index here rather than in
     * the node is what stops the vocabulary forking one datum into two.
     *
     * 1-based, matching `repeat-group.ts`: the people who write these are
     * reading a USCIS blank while they do it, and the blank numbers its blocks
     * from one.
     */
    entryIndex: integer("entry_index"),
    /** What the form calls it, e.g. "Date of Birth (mm/dd/yyyy)". */
    label: text("label").notNull(),
    /** The form's own division, e.g. "Part 1. Information About You". */
    partLabel: text("part_label"),
    /**
     * Reuses the questionnaire's type vocabulary rather than declaring a
     * parallel one. The type decides which input control renders the field, and
     * the questionnaire already has that whole set — so one enum means the
     * Forms tab and the questionnaire share their renderers instead of keeping
     * two implementations of "a date field" in step.
     */
    type: questionnaireQuestionTypeEnum("type").notNull(),
    orderIndex: integer("order_index").notNull(),
    /**
     * Guidance from the form's own instructions, where it is not obvious — and
     * what the Forms tab offers as the field's *description* when a firm writes
     * one of its own. One column rather than two: a separate `description`
     * beside this would be two boxes meaning the same thing, and nobody would
     * know which one to read.
     */
    helpText: text("help_text"),
    /**
     * Choices for a `single_choice` or `dropdown` field, in the same shape
     * `questionnaire_questions.config` uses — the two are populated from one
     * declaration in the seed, so a field offering "Male / Female" offers the
     * same list wherever it is rendered.
     */
    config: jsonb("config").notNull().default({}),
    /** Whether USCIS requires it, not whether the firm has it yet. */
    isRequired: boolean("is_required").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One row per datum per form, full stop. This was three partial unique
    // indexes — one per tier — and collapsing the tiers collapses them.
    //
    // Declared here rather than only in the migration: `drizzle-kit push`
    // diffs the database against this file and drops any index it cannot see,
    // so an index that lives only in SQL survives exactly until the next push
    // — and its disappearance surfaces as the seed failing with "no unique or
    // exclusion constraint matching the ON CONFLICT specification".
    unique("form_field_definitions_form_field_unique").on(
      t.formCode,
      t.fieldKey,
    ),
    index("form_field_definitions_form_idx").on(t.formCode),
  ],
);

/**
 * What a form *is* — its code, its name, and what it is for.
 *
 * A form used to be a bare string: `case_forms.form_code` said "I-485" and
 * nothing anywhere said what an I-485 was. That is fine while the only reader
 * is a paralegal who already knows, and useless the moment a firm adds a form
 * of its own, or a rail wants to show something more than a code.
 *
 * The platform's, like the field catalogue above and for the same reason. See
 * the note at the top of this file.
 */

/**
 * A form's parts, as far as they are more than a name on a field.
 *
 * ─── Why this table is *not* where parts come from ──────────────────────────
 *
 * A part is still, primarily, the distinct `part_label` values on a form's
 * fields — that is what the extraction produces, and what decides the order
 * parts appear in (the fields' own `order_index`). Nothing about that changed
 * and nothing should: a part whose fields say Part 9 *is* Part 9, and a second
 * source of truth for that would only ever disagree with the blank.
 *
 * What this table holds is the two things a field cannot: a **description** —
 * what the part is for, which a paralegal reads before filling it — and the
 * existence of a part that has **no fields yet**, so an operator can name one
 * and then add fields to it rather than the other way round.
 *
 * So the CRM's list of parts is the *union*: every label the fields carry, plus
 * every row here. A row without fields is an empty part; a label without a row
 * is a part nobody has described. Both are ordinary.
 *
 * `part_label` is NOT NULL, deliberately. The fields an extraction could not
 * place have no part — that is the absence of a part rather than a part called
 * nothing, it cannot be described, and a nullable column here would make
 * `(form_code, part_label)` non-unique in postgres, where NULLs never collide.
 * Naming those fields is what renaming their part does, and it is the one
 * operation that moves them into a part that can be described.
 */
export const formParts = pgTable(
  "form_parts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The form this part belongs to — `form_definitions.form_code`. */
    formCode: text("form_code").notNull(),
    /** Exactly the string the fields in this part carry as their `part_label`. */
    partLabel: text("part_label").notNull(),
    /** What the part is for, in the words a paralegal filling it needs. */
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // One row per part per form. Renaming a part rewrites this alongside every
    // field in it, so the two never drift.
    unique("form_parts_form_label_unique").on(t.formCode, t.partLabel),
    index("form_parts_form_idx").on(t.formCode),
  ],
);

export const formDefinitions = pgTable(
  "form_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** e.g. "I-485". The identity, and the join key to everything else. */
    formCode: text("form_code").notNull(),
    /** e.g. "Application to Register Permanent Residence or Adjust Status". */
    title: text("title").notNull(),
    /** What the form is for, and when a firm would file it. */
    description: text("description"),
    /**
     * Who completes the form, when it is not the firm.
     *
     * Null for almost every form: the firm fills it from the client's answers
     * and prints it, which is what this whole subsystem is for. Set where the
     * blank is **signed by somebody outside the firm entirely** — the I-693 is
     * completed and sealed by a USCIS-designated civil surgeon, and neither the
     * firm nor the client may open the envelope, let alone type into it.
     *
     * It is a column rather than a list in code because it changes what the app
     * *does*, in three places, and a list would have to be found in all three:
     * the package render leaves the form out rather than merging our blank copy
     * of it, the Forms tab shows the instruction instead of an editor, and
     * populating skips it. A blank I-693 printed into a filing package is not a
     * cosmetic mistake — it is a package that looks complete and is not, and it
     * is the exact thing USCIS rejects.
     *
     * The text is the instruction a paralegal reads, so it says what to do and
     * not merely who. Oravanti's to set, like everything else in this
     * catalogue.
     */
    providedBy: text("provided_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // A form is unique by its code — the same collapse as the field catalogue
    // above, minus `field_key`.
    unique("form_definitions_code_unique").on(t.formCode),
  ],
);

/**
 * Which practice areas a form belongs to. Many-to-many, and that is the point.
 *
 * ─── This is not an owning practice area ────────────────────────────────────
 *
 * A single owning area would be a lie: the I-864 is filed on a family-based
 * adjustment *and* on an employment-based one, the I-693 on both of those and
 * on asylum. That objection is about **one** area, and it still stands — which
 * is why this is a link table rather than a column, and why nothing reads the
 * "first" row of it.
 *
 * ─── Why it exists at all, when packages already imply it ───────────────────
 *
 * The Forms list's practice-area badges and filter were derived purely from
 * `case_type_forms` — which case types actually file the form. That is the
 * better answer and it stays the primary one, but it is empty for exactly as
 * long as a form is new, so a form somebody has just catalogued belongs to
 * nothing and appears under no filter until a package is built. On a catalogue
 * of one form that is the whole screen.
 *
 * So this says what the form is *for*, which somebody knows the moment they
 * name it, and `case_type_forms` says which matters *use* it, which is decided
 * later on the matter type's own page. The list reads the **union**: a form
 * shows every area either half names.
 *
 * It never decides what a matter opens with. Only `case_type_forms` does that,
 * and nothing here writes it — putting a form on 150 case types because
 * somebody chose "Immigration" is exactly the guess this tier does not make.
 */
export const formPracticeAreas = pgTable(
  "form_practice_areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formCode: text("form_code").notNull(),
    practiceAreaId: uuid("practice_area_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("form_practice_areas_form_idx").on(t.formCode),
    index("form_practice_areas_area_idx").on(t.practiceAreaId),
    // Picking the same area twice is one row, not two badges.
    unique("form_practice_areas_unique").on(t.formCode, t.practiceAreaId),
  ],
);

/**
 * A deliberate connection from a questionnaire question to a form field, for
 * when their keys do not already match.
 *
 * The exception, by definition. Where the question and the field call a datum
 * the same thing, population needs no row at all — see the note at the top of
 * this file — so every row here records a place where the vocabulary alone was
 * not enough, and somebody decided what should fill the box instead.
 *
 * Oravanti's, like the two catalogues above. This used to carry `scope: firm |
 * case` and a tenant column, because a firm could wire its own question onto a
 * field the platform left unmapped. It cannot any more: a firm no longer
 * authors form fields, so there is no unmapped field of its own for it to
 * point at, and pointing one of *our* fields somewhere else is exactly the
 * decision that belongs to whoever maintains the form.
 */
export const formFieldMappings = pgTable(
  "form_field_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** The form field being filled. */
    formCode: text("form_code").notNull(),
    fieldKey: text("field_key").notNull(),

    /**
     * The question that fills it, by id rather than by key — a firm or
     * per-matter question usually has no `fieldKey`, which is exactly why it
     * needs a mapping row.
     *
     * No foreign key: dropping a question should leave the mapping visibly
     * broken for someone to fix, not silently unmap a field on a form that may
     * already have been filed. The resolver skips a mapping whose question has
     * gone and says so.
     */
    sourceQuestionId: uuid("source_question_id").notNull(),

    /**
     * Set when this mapping displaces one the shared `fieldKey` vocabulary
     * already provided, and then `overrideRationale` is required.
     *
     * Kept even though one party now owns both the vocabulary and its
     * exceptions. "Why does this field not fill from the question that
     * obviously matches it?" is the question the next operator will ask, and a
     * sentence written when the decision was made answers it better than
     * anything reconstructed later.
     */
    overridesSharedKey: boolean("overrides_shared_key")
      .notNull()
      .default(false),
    overrideRationale: text("override_rationale"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    /** One mapping per field. A box holds one datum. */
    unique("form_field_mappings_field_unique").on(t.formCode, t.fieldKey),
    index("form_field_mappings_form_idx").on(t.formCode),
  ],
);

/**
 * What is actually on one matter's copy of one form.
 *
 * This is the table `case_forms`'s own header promised: that row tracks the
 * form's *standing* — filed, receipted, approved — and this one holds its
 * *content*.
 *
 * A row exists only once the field has a value. An unfilled field is the
 * absence of a row, not a row holding null, so "how much of this form is
 * populated?" is a count rather than a scan for emptiness.
 */
export const caseFormFieldValues = pgTable(
  "case_form_field_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    caseFormId: uuid("case_form_id")
      .notNull()
      .references(() => caseForms.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),

    /** Same `jsonb` shape as `questionnaire_answers.value`, so carrying a value across is a copy. */
    value: jsonb("value").notNull(),
    valueSource: formFieldValueSourceEnum("value_source").notNull(),

    /**
     * True once a person has edited this field by hand.
     *
     * A manual edit outranks any later refill: a paralegal corrected it for a
     * reason, and a re-run of population must not quietly undo that. But the
     * source is not discarded either — `sourceValue` below keeps what the
     * questionnaire says, so a client changing their name *after* the
     * correction shows up as a disagreement instead of vanishing.
     */
    isManualOverride: boolean("is_manual_override").notNull().default(false),

    /**
     * What the source last said, kept alongside a manual override so the two
     * can be compared. Null when the value came straight from the source and
     * there is nothing to disagree with.
     */
    sourceValue: jsonb("source_value"),

    /** Which question this came from, when it came from one. Provenance, not a join key. */
    sourceQuestionId: uuid("source_question_id"),

    updatedById: uuid("updated_by_id").references(() => staff.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("case_form_field_values_form_field_unique").on(
      t.caseFormId,
      t.fieldKey,
    ),
    index("case_form_field_values_case_form_idx").on(t.caseFormId),
    index("case_form_field_values_organization_idx").on(t.organizationId),
  ],
);

/**
 * Who changed a form. Two answers, and the distinction is the point.
 *
 * `questionnaire` is a population run carrying an answer across; `staff` is
 * somebody typing on the form itself. A form that turns out to be wrong is
 * asked "did we type this or did the client say it?", and the value's
 * `valueSource` answers that for the *current* value only — the history needs
 * to answer it for every value the field has ever held.
 */
export const caseFormVersionActorEnum = pgEnum("case_form_version_actor", [
  "staff",
  "questionnaire",
]);

export type CaseFormVersionActor =
  (typeof caseFormVersionActorEnum.enumValues)[number];

/**
 * One save against one form.
 *
 * Per form rather than per package, because a form is the unit that is filled,
 * saved and filed. A population run touching five forms writes five versions —
 * one on each — so opening an I-485's history shows the I-485 and nothing else.
 *
 * `values` is the whole form at that moment, which is what makes "restore to
 * here" a read rather than a replay of every revision since.
 */
export const caseFormVersions = pgTable(
  "case_form_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    caseFormId: uuid("case_form_id")
      .notNull()
      .references(() => caseForms.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    actor: caseFormVersionActorEnum("actor").notNull(),
    /** Null for a population run, which no one person performed. */
    savedById: uuid("saved_by_id").references(() => staff.id),
    /** `{ fieldKey: value }` for every field on the form at this moment. */
    values: jsonb("values").notNull(),
    changedCount: integer("changed_count").notNull().default(0),
    /** Set when this save was a restore, naming what it restored. */
    restoredFromVersionId: uuid("restored_from_version_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("case_form_versions_number_unique").on(
      t.caseFormId,
      t.versionNumber,
    ),
    index("case_form_versions_form_idx").on(t.caseFormId),
    index("case_form_versions_org_idx").on(t.organizationId),
  ],
);

/** One field's before-and-after, at one moment. */
export const caseFormFieldRevisions = pgTable(
  "case_form_field_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    caseFormId: uuid("case_form_id")
      .notNull()
      .references(() => caseForms.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => caseFormVersions.id, { onDelete: "cascade" }),
    /**
     * By key rather than by definition id: a field can be superseded, or
     * removed from the catalogue outright, and neither should erase the record
     * that the form once said something in that box.
     */
    fieldKey: text("field_key").notNull(),
    previousValue: jsonb("previous_value"),
    value: jsonb("value"),
    /** Where the value came from before and after, so a hand edit is legible. */
    previousSource: formFieldValueSourceEnum("previous_source"),
    source: formFieldValueSourceEnum("source"),
    actor: caseFormVersionActorEnum("actor").notNull(),
    changedById: uuid("changed_by_id").references(() => staff.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("case_form_field_revisions_form_idx").on(t.caseFormId),
    index("case_form_field_revisions_version_idx").on(t.versionId),
    index("case_form_field_revisions_field_idx").on(
      t.caseFormId,
      t.fieldKey,
      t.createdAt,
    ),
    index("case_form_field_revisions_org_idx").on(t.organizationId),
  ],
);

export type FormFieldDefinition = typeof formFieldDefinitions.$inferSelect;
export type FormDefinition = typeof formDefinitions.$inferSelect;
export type FormFieldMapping = typeof formFieldMappings.$inferSelect;
export type CaseFormFieldValue = typeof caseFormFieldValues.$inferSelect;
export type CaseFormVersion = typeof caseFormVersions.$inferSelect;
export type CaseFormFieldRevision = typeof caseFormFieldRevisions.$inferSelect;
