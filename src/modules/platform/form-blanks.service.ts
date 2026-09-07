/**
 * A form's editions, and the blank each one is filed on.
 *
 * ─── What an operator actually does here ────────────────────────────────────
 *
 * Downloads a blank from uscis.gov, records the edition it is (the date printed
 * at the foot of every page, and the window USCIS accepts it in), uploads the
 * file, reads what the import would do to the catalogue, and confirms it. That
 * whole sequence used to be a pull request — four coordinated things, one of
 * which was a binary — and USCIS publishes editions on its own schedule,
 * sometimes with no grace period at all.
 *
 * ─── Upload and import are two steps on purpose ─────────────────────────────
 *
 * Uploading stores the file, records its checksum, reads the boxes off it and
 * writes the extraction beside it. It changes **nothing** about the catalogue.
 * Importing is what writes `form_field_definitions` and
 * `form_pdf_field_mappings`, and it is confirmed against a plan that says what
 * will change.
 *
 * The old arrangement got that review from a diff on a committed JSON file.
 * Dropping the file is not a reason to drop the review: these rows decide what
 * prints on a statutory form for every firm in the deployment, and "I uploaded
 * the wrong edition" is a mistake somebody will make on a Tuesday.
 */

import { readFile } from "node:fs/promises";

import { and, asc, eq, isNull } from "drizzle-orm";
import { PDFDocument } from "@cantoo/pdf-lib";

import { systemDb } from "../../db/client";
import { formEditions } from "../../db/schema/form-editions";
import { formDefinitions } from "../../db/schema/form-fields";
import {
  applyImport,
  planImport,
  unmappedCuratedFields,
  type ImportPlan,
} from "../workflow/form-catalogue-import.service";
import { extractForm } from "../workflow/form-extraction.service";
import { bindToSchemaNodes } from "../../db/seeds/schema-nodes.seed";
import {
  blankKey,
  extractionKey,
  forgetBlank,
  readBlank,
  sha256,
  writeBlank,
  writeExtraction,
} from "../workflow/form-blank-storage";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

/** Every edition on record for a form, newest first, with its blank's state. */
export const listEditions = async (formCode: string) => {
  const rows = await systemDb
    .select()
    .from(formEditions)
    .where(eq(formEditions.formCode, formCode))
    .orderBy(asc(formEditions.editionDate));

  return rows
    .map((row) => ({
      id: row.id,
      formCode: row.formCode,
      editionDate: row.editionDate,
      acceptedFrom: row.acceptedFrom,
      acceptedUntil: row.acceptedUntil,
      sourceUrl: row.sourceUrl,
      verifiedOn: row.verifiedOn,
      /**
       * Whether a blank has been uploaded, rather than where it is. The key is
       * an implementation detail of storage and there is nothing a client can
       * do with it — the bytes are served by this API, not fetched directly.
       */
      hasBlank: row.blankObjectKey !== null,
      blankChecksum: row.blankChecksum,
      blankBytes: row.blankBytes,
      blankUploadedAt: row.blankUploadedAt,
      extractedAt: row.extractedAt,
      /*
        The pair the row reads to tell "uploaded" from "finished". Sent as two
        timestamps rather than one boolean because a *replaced* blank is the
        third state: imported once, uploaded again, not re-imported — and a
        boolean computed here would call that done.
      */
      importedAt: row.importedAt,
    }))
    .reverse();
};

const editionOr404 = async (formCode: string, editionId: string) => {
  const [edition] = await systemDb
    .select()
    .from(formEditions)
    .where(and(eq(formEditions.id, editionId), eq(formEditions.formCode, formCode)))
    .limit(1);

  if (!edition) {
    throw new NotFoundError(`No ${formCode} edition with that id`);
  }
  return edition;
};

/**
 * Record a new edition of a form.
 *
 * The blank is uploaded separately, because the two are separate facts: USCIS
 * announces an edition and its acceptance window months before anybody has
 * downloaded the PDF, and an edition with no blank is a legitimate state that
 * the CRM shows rather than hides. It just cannot be filled or printed.
 */
export const addEdition = async (input: {
  formCode: string;
  editionDate: string;
  acceptedFrom: string;
  acceptedUntil?: string | null;
  sourceUrl?: string | null;
  verifiedOn?: string | null;
}) => {
  const [form] = await systemDb
    .select({ formCode: formDefinitions.formCode })
    .from(formDefinitions)
    .where(eq(formDefinitions.formCode, input.formCode))
    .limit(1);

  if (!form) {
    throw new NotFoundError(
      `${input.formCode} is not in the catalogue. Name the form before recording an edition of it.`,
    );
  }

  const [created] = await systemDb
    .insert(formEditions)
    .values({
      formCode: input.formCode,
      editionDate: input.editionDate,
      acceptedFrom: input.acceptedFrom,
      acceptedUntil: input.acceptedUntil ?? null,
      sourceUrl: input.sourceUrl ?? null,
      verifiedOn: input.verifiedOn ?? null,
    })
    .onConflictDoNothing({
      target: [formEditions.formCode, formEditions.editionDate],
    })
    .returning();

  if (!created) {
    throw new BadRequestError(
      `${input.formCode} already has a ${input.editionDate} edition on record.`,
    );
  }
  return created;
};

export const updateEdition = async (
  formCode: string,
  editionId: string,
  patch: {
    acceptedFrom?: string;
    acceptedUntil?: string | null;
    sourceUrl?: string | null;
    verifiedOn?: string | null;
  },
) => {
  await editionOr404(formCode, editionId);
  const [updated] = await systemDb
    .update(formEditions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(formEditions.id, editionId))
    .returning();

  return updated;
};

/**
 * Store a blank against an edition and read its boxes.
 *
 * ─── Three things this refuses ──────────────────────────────────────────────
 *
 * **A file that is not a fillable PDF.** The MIME allowlist on the upload
 * catches a JPEG called `i485.pdf`; it does not catch a *flat* PDF — a scan, or
 * the print-ready version USCIS also publishes — which parses fine and has no
 * AcroForm at all. That one is worth naming, because "0 fields extracted" with
 * no explanation is how somebody concludes the feature is broken.
 *
 * **A blank that is byte-identical to the one already there.** Re-uploading the
 * same file is a no-op, reported as one. Without this it would restate every
 * row with what it already says and stamp a new `extractedAt`, which makes the
 * audit trail claim work happened.
 *
 * **Nothing about the catalogue.** This writes storage and four columns. The
 * plan it returns is a description; `importCatalogue` is what acts on it.
 */
export const uploadBlank = async (
  formCode: string,
  editionId: string,
  bytes: Buffer,
) => {
  const edition = await editionOr404(formCode, editionId);
  const checksum = sha256(bytes);

  if (edition.blankChecksum === checksum) {
    return {
      unchanged: true as const,
      edition,
      plan: null,
      boxes: 0,
    };
  }

  let boxCount: number;
  try {
    const doc = await PDFDocument.load(bytes, { password: "" });
    boxCount = doc.getForm().getFields().length;
  } catch (error) {
    throw new BadRequestError(
      `That file could not be read as a PDF: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  if (boxCount === 0) {
    throw new BadRequestError(
      "That PDF has no fillable boxes, so there is nothing to catalogue. USCIS publishes a flat, print-only version of most forms alongside the fillable one — check that this is the fillable blank.",
    );
  }

  const key = blankKey(formCode, edition.editionDate);
  // Replacing a corrected blank reuses the key, so anything already cached
  // under it is now the wrong file. Forget before writing, not after: a read
  // racing the upload should miss rather than get the stale bytes.
  forgetBlank(key);
  await writeBlank(key, bytes);

  const extraction = await extractForm(formCode, bytes);
  const extractionAt = extractionKey(formCode, edition.editionDate);
  await writeExtraction(extractionAt, { formCode, ...extraction });

  const [saved] = await systemDb
    .update(formEditions)
    .set({
      blankObjectKey: key,
      blankChecksum: checksum,
      blankBytes: bytes.byteLength,
      blankUploadedAt: new Date(),
      extractionObjectKey: extractionAt,
      extractedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(formEditions.id, editionId))
    .returning();

  return {
    unchanged: false as const,
    edition: saved,
    plan: await planImport(saved, extraction),
    boxes: boxCount,
    skipped: extraction.skipped,
    noTooltip: extraction.noTooltip,
    parts: extraction.parts,
  };
};

/**
 * What importing this edition's blank would do to the catalogue.
 *
 * Re-extracts rather than storing the plan from the upload. The blank is
 * cached, extraction is a pass over a list already in memory, and a plan held
 * server-side between two requests would be a fourth thing that can be stale.
 */
export const previewImport = async (
  formCode: string,
  editionId: string,
): Promise<ImportPlan> => {
  const edition = await editionOr404(formCode, editionId);
  if (!edition.blankObjectKey) {
    throw new BadRequestError(
      `No blank has been uploaded for the ${edition.editionDate} edition of ${formCode}.`,
    );
  }

  const extraction = await extractForm(
    formCode,
    await readBlank(edition.blankObjectKey),
  );
  return planImport(edition, extraction);
};

/** Write the catalogue from this edition's blank. The confirmed step. */
export const importCatalogue = async (formCode: string, editionId: string) => {
  const edition = await editionOr404(formCode, editionId);
  if (!edition.blankObjectKey) {
    throw new BadRequestError(
      `No blank has been uploaded for the ${edition.editionDate} edition of ${formCode}.`,
    );
  }

  const extraction = await extractForm(
    formCode,
    await readBlank(edition.blankObjectKey),
  );
  const plan = await applyImport(edition, extraction);

  /*
    Bind, immediately, and never as a separate thing somebody remembers.

    `schema_node_id` is what says a field carries a shared datum: it is what the
    mapper paints green, what the coverage bar counts, and what population
    joins on. A field row is inserted with it null, so the binding pass has to
    follow the rows that exist — and nothing *fails* when it does not run. The
    form appears in the CRM, every box is amber, and the count reads "0 of 438
    boxes carry a datum" on a screen that otherwise looks like it worked.

    That trap already bit once, on the first database reset after the vocabulary
    was built, which is why `seedWorkflows` closes the same ordering in the CLI.
    An import is the other door onto the same rows, so it closes it too.
  */
  const bound = await bindToSchemaNodes();

  /*
    Recorded last, so it means "these rows were written" rather than "somebody
    started". A failure anywhere above leaves it null and the row keeps saying
    the fields are not saved, which is the truth.
  */
  await systemDb
    .update(formEditions)
    .set({ importedAt: new Date(), updatedAt: new Date() })
    .where(eq(formEditions.id, editionId));

  return {
    ...plan,
    boundFields: bound.formFields,
    // Each of these is a curated field standing beside no box — a decision
    // waiting to be made, not an error. Named rather than counted, because
    // pointing one at its box is what makes it print.
    unmappedCurated: await unmappedCuratedFields(formCode, editionId),
  };
};

/**
 * Every edition on record with no blank uploaded against it.
 *
 * Not an error list. An operator records an edition from the date USCIS
 * announces and uploads the PDF whenever they get to it, so this is the normal
 * state of anything recorded in the last five minutes.
 *
 * It is worth reporting anyway, because nothing *fails* when a blank is
 * missing: the CRM loads, the form is listed, the filing package is right, and
 * the gap only shows when somebody opens a matter's Forms tab and finds a form
 * that will not print. `form-blanks-status` is that report.
 */
export const editionsWithoutBlanks = async () =>
  systemDb
    .select({
      formCode: formEditions.formCode,
      editionDate: formEditions.editionDate,
    })
    .from(formEditions)
    .where(isNull(formEditions.blankObjectKey))
    .orderBy(asc(formEditions.formCode), asc(formEditions.editionDate));

/**
 * One edition's blank, uploaded and imported from a file path.
 *
 * The terminal door onto the same two calls the CRM makes, for when a form is
 * being added from a script. `editionDate` is required rather than defaulted to
 * the one currently accepted: a blank filed against the wrong edition maps
 * every box on it to a document USCIS will reject, and there is no error at the
 * point that happens.
 */
export const importBlankFromFile = async (
  formCode: string,
  editionDate: string,
  file: string,
) => {
  const [edition] = await systemDb
    .select()
    .from(formEditions)
    .where(
      and(
        eq(formEditions.formCode, formCode),
        eq(formEditions.editionDate, editionDate),
      ),
    )
    .limit(1);

  if (!edition) {
    throw new Error(
      `${formCode} has no ${editionDate} edition on record. Add the edition first — its acceptance window is what decides whether a filing may use it.`,
    );
  }

  await uploadBlank(formCode, edition.id, await readFile(file));
  return importCatalogue(formCode, edition.id);
};
