import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Which edition of a USCIS form is acceptable on a given filing date.
 *
 * Global reference data, platform-maintained and not tenant-scoped — same
 * category as `uscis_processing_time_reference` and `practice_areas`.
 *
 * USCIS prints an edition date at the foot of every page and rejects filings
 * made on a superseded edition. Some transitions come with a grace period in
 * which two editions are both accepted; others take effect with none at all.
 * Modelling each edition as a half-open acceptance window covers both without a
 * special case: overlapping windows mean "either edition is fine", disjoint
 * windows mean the change was immediate, and a null `acceptedUntil` marks the
 * edition currently in force.
 *
 * `formCode` is deliberately free text rather than the `filing_type` enum: a
 * package carries forms that are never themselves a filing type (I-130A, I-864,
 * I-693), and this table is about paper, not about what kind of case it is.
 */
export const formEditions = pgTable(
  "form_editions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** e.g. "I-485", "I-130A", "I-864". */
    formCode: text("form_code").notNull(),
    /** The date printed on the form, e.g. "2026-09-18" for the 09/18/26 edition. */
    editionDate: date("edition_date").notNull(),
    /** First filing date this edition may be used on. */
    acceptedFrom: date("accepted_from").notNull(),
    /** Last filing date this edition may be used on; null while it is current. */
    acceptedUntil: date("accepted_until"),
    /** The USCIS page or alert this row was read from, so it can be re-verified. */
    sourceUrl: text("source_url"),
    /** When a human last checked this row against uscis.gov. */
    verifiedOn: date("verified_on"),
    /**
     * The object key of the blank PDF this edition is filed on.
     *
     * Held per edition rather than per form because that is the grain that is
     * actually true: USCIS reflows the page between editions and the AcroForm
     * field names move with it, so a blank and the mapping below are only ever
     * valid for the one edition they were taken from. Null until a blank has
     * been uploaded — a form is still perfectly usable without one, it just
     * cannot be rendered as the filed document, and every screen that reaches
     * for one says so rather than failing.
     *
     * This was a path into `oravanti-be/forms/` and is now a key in object
     * storage, built by `form-blank-storage.ts`. The reason for the move is in
     * that file: a blank in the repo made every new form — and every new USCIS
     * edition of a form already catalogued — a deploy.
     */
    blankObjectKey: text("blank_object_key"),
    /**
     * SHA-256 of those bytes, and how many there are.
     *
     * A blank is the document every filing under this edition prints on, so
     * "is the file behind this edition still the one the catalogue was read
     * off?" has to be answerable. It is also what lets re-uploading the same
     * file be recognised as a no-op rather than starting an extraction that
     * would rewrite every row with what they already say.
     */
    blankChecksum: text("blank_checksum"),
    blankBytes: integer("blank_bytes"),
    blankUploadedAt: timestamp("blank_uploaded_at"),
    /**
     * What the extractor read off that blank, and when.
     *
     * The extraction is kept beside the blank as the record of a claim — these
     * boxes, these labels, these parts, read on this date — and because a
     * re-extraction is worth diffing against the last one. It is deliberately
     * never read back to build the catalogue: `form_field_definitions` is the
     * catalogue, and a file that is loaded as well as written is a second
     * source of truth waiting to disagree. That disagreement is exactly what
     * the old hand-written `FORMS` constant was.
     */
    extractionObjectKey: text("extraction_object_key"),
    extractedAt: timestamp("extracted_at"),
    /**
     * When this blank's fields were last written into the catalogue.
     *
     * `extractedAt` says the boxes were *read* — that happens on upload and
     * changes nothing anybody can see. This says they were **applied**, which
     * is the separate, confirmed second step, and the two are days apart when
     * somebody uploads on a Friday and reviews the plan on a Monday.
     *
     * It exists because the gap between them was invisible and reachable: the
     * import plan lived only in the browser, so leaving the page stranded a
     * stored blank with no route back to it — the form kept the fields it had,
     * the row said it had a PDF, and nothing on any screen disagreed. Null
     * here, or a `blankUploadedAt` later than it, is what the row shows as
     * *Fields not saved yet*.
     */
    importedAt: timestamp("imported_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("form_editions_form_idx").on(t.formCode),
    // The seed upserts on this pair; without it a re-run duplicates rows.
    unique("form_editions_form_edition_unique").on(t.formCode, t.editionDate),
  ],
);

export type FormEdition = typeof formEditions.$inferSelect;
export type NewFormEdition = typeof formEditions.$inferInsert;

/**
 * Which box on the blank PDF a field key prints into.
 *
 * `form_field_definitions.field_key` names a *datum* — `beneficiary.date_of_birth`
 * — and deliberately says nothing about where it appears on a page. That is the
 * right shape for the catalogue, because the same datum fills a box on the
 * I-130 and a different box on the I-485. This table is the other half: the one
 * place that does know about paper.
 *
 * Keyed by edition rather than form code for the reason given above — the
 * AcroForm field names are a property of the exact PDF, not of "the I-130".
 * When USCIS publishes a new edition, its mapping is a new set of rows and the
 * old ones stay valid for filings already prepared on the old blank.
 *
 * Platform reference data, like `form_editions` itself: the I-130 PDF is the
 * same document for every firm, so there is nothing tenant-specific to scope.
 */
export const formPdfFieldMappings = pgTable(
  "form_pdf_field_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formEditionId: uuid("form_edition_id")
      .notNull()
      .references(() => formEditions.id, { onDelete: "cascade" }),
    /** Matches `form_field_definitions.field_key`. Free text, not an FK: this
     *  mapping is about the datum, which outlives any one edition's field list
     *  — a key stays mapped across an edition that re-numbers its boxes. */
    fieldKey: text("field_key").notNull(),
    /** The AcroForm field name inside the blank, read out of the PDF itself. */
    pdfFieldName: text("pdf_field_name").notNull(),
    /**
     * Which *answer* puts a mark in this box. Null for a box that takes a value
     * rather than a mark.
     *
     * ─── Why a datum can need several boxes ───────────────────────────────────
     *
     * A text box is one-to-one: `beneficiary.date_of_birth` goes in
     * `Pt4Line9_DateOfBirth[0]` and there is nothing else to say. A *choice* is
     * not. USCIS does not print a dropdown; it prints one checkbox per option,
     * each with its own AcroForm name:
     *
     *     Pt1Line1_Spouse[0]  Pt1Line1_Siblings[0]
     *     Pt1Line1_Parent[0]  Pt1Line1_Child[0]
     *
     * One row per box, each naming the answer that ticks it, is what makes
     * "Parent" reach `Pt1Line1_Parent[0]` instead of being written at whichever
     * box happened to be listed first. Before this column existed the catalogue
     * kept only the first box of each group: answering "Parent" ticked nothing,
     * the other three boxes were unreachable — 83 boxes on the I-130 and 198 on
     * the I-485, every "No" among them — and the fill reported success.
     *
     * The value is matched against the answer, case-insensitively, and must be
     * one of the option strings in the field definition's `config.options`.
     */
    fieldValue: text("field_value"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("form_pdf_field_mappings_edition_idx").on(t.formEditionId),
    index("form_pdf_field_mappings_field_idx").on(t.formEditionId, t.fieldKey),

    // ─── One datum per box, always ─────────────────────────────────────────
    //
    // Two answers racing for the same box is a filing error nobody would catch
    // by eye, and that holds whether the box takes a mark or a value.
    unique("form_pdf_field_mappings_box_unique").on(
      t.formEditionId,
      t.pdfFieldName,
    ),

    // ─── But a datum prints into as many boxes as the form asks it ─────────
    //
    // There is deliberately no unique index the other way round. A blank asks
    // the same thing twice: the I-130 wants the date of the marriage in Part
    // 2, from the petitioner, and again in Part 4, from the beneficiary. One
    // date, two boxes, and both have to print. While a datum was unique per
    // edition that pair could not be seeded at all — it failed on the
    // constraint, and the only ways to satisfy it were to leave Part 4 blank
    // or to ask the client the same date twice under two names.
    //
    // What the index was there to prevent — a datum quietly acquiring a second
    // box — is `fillForCase`'s to prevent instead, by writing *every* box in
    // the group. A wrong extra box then prints where somebody reading the
    // paper sees it, rather than sitting unnoticed in a table.
  ],
);

export type FormPdfFieldMapping = typeof formPdfFieldMappings.$inferSelect;
export type NewFormPdfFieldMapping = typeof formPdfFieldMappings.$inferInsert;
