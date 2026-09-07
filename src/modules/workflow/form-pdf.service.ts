import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  PDFTextField,
} from "@cantoo/pdf-lib";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client";
import {
  caseFormFieldValues,
  caseForms,
  formEditions,
  formFieldDefinitions,
  formPdfFieldMappings,
  type FormEdition,
} from "../../db/schema";
import { createModuleLogger, LogEvent } from "../../lib/logging/log";
import { defaultPackageFor } from "./case-forms.service";
import { catalogueFields, listCatalogueForms } from "./form-catalogue.service";
import {
  continuationBlocks,
  fillContinuation,
  type ContinuationBlock,
} from "./continuation-sheet";
import { repeatGroupsForCase } from "./form-population.service";
import { readBlank } from "./form-blank-storage";
import { sameAnswer } from "./pdf-field-naming";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";

const log = createModuleLogger("workflow.form-pdf");

/**
 * Where one widget of a box sits on the printed page.
 *
 * Percentages of the page box, top-left origin — i.e. already in the
 * browser's coordinates, so the mapper positions a `<Box>` with these numbers
 * and nothing in between converts anything. See `placementReader`.
 */
export type BoxPlacement = {
  /** Zero-based, as `getPages()` orders them. */
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * Filling an official blank with a matter's answers.
 *
 * ─── The two halves ─────────────────────────────────────────────────────────
 *
 * `form_field_definitions.field_key` names a *datum* — `beneficiary.date_of_birth`
 * — and deliberately says nothing about paper. `form_pdf_field_mappings` is the
 * other half: which box on which edition's blank that datum prints into. This
 * service is where the two meet.
 *
 * ─── Why the blanks open with an empty password ─────────────────────────────
 *
 * USCIS publishes its forms with the standard security handler set to
 * owner-password-only (`/P -20`, no user password). That restricts *permissions*
 * — it is what stops a viewer offering "edit" — and does not restrict opening:
 * every PDF reader opens these by supplying an empty user password, which is
 * exactly what `{ password: "" }` does below. It is also why plain `pdf-lib`
 * cannot read them at all and `@cantoo/pdf-lib` can.
 */
export class FormPdfService {

  /**
   * The edition a filing made *today* should be prepared on.
   *
   * ─── Why this is a date question, not a "latest row" question ─────────────
   *
   * `acceptedFrom`/`acceptedUntil` are a half-open acceptance window, and an
   * edition USCIS has announced but not yet started accepting is on record with
   * `acceptedUntil` null — null means "no end date set", not "in force". The
   * I-485 has exactly this shape: the 01/20/25 edition runs until 2026-09-17,
   * and the 09/18/26 edition is already on record with a null end. Picking the
   * null-ended row would prepare filings on an edition USCIS will reject until
   * September.
   *
   * Where two windows overlap — a grace period in which either edition is
   * accepted — the newer one wins, which is the one that will still be valid
   * when the grace period closes.
   */
  private currentEdition = async (formCode: string) => {
    const today = sql`current_date`;

    const [inForce] = await db
      .select()
      .from(formEditions)
      .where(
        and(
          eq(formEditions.formCode, formCode),
          sql`${formEditions.acceptedFrom} <= ${today}`,
          sql`(${formEditions.acceptedUntil} is null or ${formEditions.acceptedUntil} >= ${today})`,
        ),
      )
      .orderBy(desc(formEditions.editionDate))
      .limit(1);

    if (inForce) return inForce;

    // Nothing is in force, which means the reference data has fallen behind
    // rather than that the form has ceased to exist. Fall back to the newest
    // edition on record so the form still renders, and say so loudly enough
    // that somebody goes and checks uscis.gov.
    const [newest] = await db
      .select()
      .from(formEditions)
      .where(eq(formEditions.formCode, formCode))
      .orderBy(desc(formEditions.editionDate))
      .limit(1);

    if (!newest) {
      throw new NotFoundError(`No edition on record for ${formCode}`);
    }

    log.warn(
      LogEvent.WORKFLOW_FORM_EDITION_STALE,
      { formCode, fellBackTo: newest.editionDate },
      "No edition is accepted as of today; check form_editions against uscis.gov",
    );
    return newest;
  };

  /**
   * The bytes of one edition's blank, fetched from object storage.
   *
   * An edition with no blank is an ordinary state, not a broken one: a form is
   * catalogued, its editions are on record, and somebody has yet to upload the
   * PDF for this one. The message says what to do about it, because the person
   * reading it is an operator on the form's own page in the CRM, one control
   * away from fixing it.
   */
  private blankBytes = async (edition: FormEdition) => {
    if (!edition.blankObjectKey) {
      throw new NotFoundError(
        `No blank has been uploaded for the ${edition.editionDate} edition of ${edition.formCode}. Upload it on that form's page in the CRM; the catalogue is read off the file.`,
      );
    }
    return readBlank(edition.blankObjectKey);
  };

  private loadBlank = async (edition: FormEdition) =>
    this.openBlank(await this.blankBytes(edition));

  /**
   * One blank PDF, opened and made writable.
   *
   * Takes bytes rather than fetching them, so extraction can reach it with a
   * buffer that has just been uploaded and has no edition row behind it yet —
   * see `listBoxesForBytes`. It is also what keeps the cache in
   * `form-blank-storage.ts` honest: the parse happens per caller, because
   * filling mutates the document, while only the bytes are shared.
   */
  private openBlank = async (bytes: Buffer) => {
    const doc = await PDFDocument.load(bytes, { password: "" });
    this.dropEncryptionRemnants(doc, bytes);
    this.dropRichTextFormatting(doc);
    return doc;
  };

  /**
   * Turn every rich-text box on the blank into a plain one.
   *
   * The same argument as dropping the XFA layer, for the same reason. A rich
   * text field holds its content twice — `/V` as plain text and `/RV` as a
   * fragment of styled markup — and a reader that sees the rich flag renders
   * `/RV`, which is not what we write into. So the flag is against us even on a
   * box we do fill.
   *
   * It also breaks saving outright, which is how it was found. `save()`
   * regenerates the appearance stream of every field that lacks one — not only
   * the fields we touched — and generating one means reading the field's text,
   * which pdf-lib refuses to do for a rich field with no plain value:
   *
   *     Reading rich text fields is not supported: Attempted to read rich text
   *     field: form1[0].#subform[24].P14_Line5_AdditionalInfo[0]
   *
   * That is one of the I-485's four Part 14 "Additional Information" boxes,
   * empty and unmapped, taking down the whole document on its way past. The
   * I-130 has none, which is why it never showed up until the second form.
   *
   * Clearing the flag on the blank is safe: a blank's boxes have no content to
   * lose, and `setText()` clears it per-field anyway — this only extends that to
   * the boxes nobody filled.
   */
  private dropRichTextFormatting = (doc: PDFDocument) => {
    for (const field of doc.getForm().getFields()) {
      if (field instanceof PDFTextField && field.isRichFormatted()) {
        field.disableRichFormatting();
      }
    }
  };

  /**
   * Remove the encryption leftovers that would otherwise be written back out.
   *
   * Loading decrypts the document in memory — `doc.isEncrypted` is false
   * straight afterwards — but two kinds of object survive into `save()` and
   * between them they produce a *malformed* file: the standard security handler
   * dictionary, and the original cross-reference streams, which carry an
   * `/Encrypt N 0 R` entry naming it. Saved as-is, the result has a trailer
   * pointing at an encryption dictionary whose contents are now plaintext, and
   * readers refuse it — `PDFDocument.load` on our own output fails with
   * "NEEDS PASSWORD" unless encryption is ignored.
   *
   * These objects are vestigial: `save()` writes a fresh cross-reference table,
   * and a filled form is not meant to carry the blank's permission flags. They
   * are found by scanning the source bytes rather than the parsed context,
   * because the parser does not expose them as indirect objects — which is
   * exactly why they slip through untouched.
   */
  private dropEncryptionRemnants = (
    doc: PDFDocument,
    bytes: Buffer | Uint8Array,
  ) => {
    const raw = Buffer.from(bytes).toString("latin1");
    const doomed = new Set<number>();

    for (const match of raw.matchAll(/\/Encrypt\s+(\d+)\s+\d+\s+R/g)) {
      // The security handler itself.
      doomed.add(Number(match[1]));

      // And whichever object carried the reference — the nearest `N 0 obj`
      // header behind it, which is one of the original xref streams.
      const header = raw.slice(0, match.index).match(/(\d+)\s+\d+\s+obj[^]*$/);
      if (header) doomed.add(Number(header[1]));
    }

    for (const objectNumber of doomed) {
      doc.context.delete(PDFRef.of(objectNumber, 0));
    }
  };

  /**
   * Every fillable box on a form's blank.
   *
   * Barcode fields are dropped: USCIS puts a PDF417 text field on every page
   * that its own software populates, and offering them as mapping targets is
   * twelve wrong answers at the top of the list.
   */
  listBoxes = async (formCode: string) =>
    this.boxesOf(await this.loadBlank(await this.currentEdition(formCode)));

  /**
   * The same list, read off bytes in hand, with no database and no storage.
   *
   * ─── Why extraction must not need an edition row ────────────────────────
   *
   * The order a person actually works in is: get the blank, read the boxes off
   * it, then decide what they mean. Routing that through `currentEdition`
   * inverts it — the boxes could not be read until an edition row existed to
   * read them "for", so adding a form meant recording a guess and correcting it
   * once the extraction proved it wrong.
   *
   * Nothing about reading boxes off a blank is edition-specific except which
   * bytes to open. This is the path an upload takes, before anything has been
   * written down about the file that just arrived.
   */
  listBoxesForBytes = async (bytes: Buffer) =>
    this.boxesOf(await this.openBlank(bytes));

  private boxesOf = (doc: PDFDocument) => {
    const placementsOf = this.placementReader(doc);

    return doc
      .getForm()
      .getFields()
      .map((field) => {
        const name = field.getName();
        const tooltip = this.tooltipOf(field);
        const placements = placementsOf(field);
        if (field instanceof PDFCheckBox) {
          return {
            name,
            tooltip,
            kind: "checkbox" as const,
            options: [] as string[],
            placements,
          };
        }
        if (field instanceof PDFDropdown) {
          return {
            name,
            tooltip,
            kind: "dropdown" as const,
            options: field.getOptions().filter((o) => o.trim() !== ""),
            placements,
          };
        }
        return {
          name,
          tooltip,
          kind: "text" as const,
          options: [] as string[],
          placements,
        };
      })
      .filter((box) => !/BarCode/i.test(box.name));
  };

  /**
   * Where a box sits on the paper, so it can be pointed at rather than read
   * off a list of names.
   *
   * ─── Why percentages, and why nothing is stored ─────────────────────────
   *
   * The mapper draws these over a page the browser rendered at whatever width
   * the pane happens to be. Percentages of the page box survive that, and they
   * survive the browser and this process disagreeing about DPI, which they
   * will. Points would not.
   *
   * None of it is written down. The blank is already on disk and already
   * opened to serve the preview, so coordinates in the database would be a
   * second copy that goes stale the day USCIS nudges a box — with nothing able
   * to notice, and a reseed rather than a file swap to correct it.
   *
   * ─── One field is not one box ───────────────────────────────────────────
   *
   * `getWidgets()` is an array because a field can print in more than one
   * place: a radio group is one name over six boxes (the I-485's marital
   * status), and some text fields genuinely repeat across pages. So a box
   * carries *placements*, plural, and a box none of whose widgets resolve to a
   * page keeps its row with an empty list — the PDF boxes screen is a
   * checklist of what still needs wiring, and it must not quietly shorten.
   *
   * The page-ref map is the same trick `findSlots` uses in
   * `continuation-sheet.ts`: a widget names its page by reference, and only
   * `getPages()` puts those references in order.
   */
  private placementReader = (doc: PDFDocument) => {
    const pages = doc.getPages();
    const pageIndex = new Map(pages.map((page, index) => [page.ref.tag, index]));

    return (field: PDFField): BoxPlacement[] => {
      const placements: BoxPlacement[] = [];

      for (const widget of field.acroField.getWidgets()) {
        const parent = widget.P();
        const page = parent ? pageIndex.get(parent.tag) : undefined;
        if (page === undefined) continue;

        // A rotated page is laid out by the viewer, not by us, so its boxes
        // would land somewhere plausible and wrong. No USCIS blank has one;
        // if one appears, it reads as "not located" rather than misplaced.
        if (pages[page].getRotation().angle % 360 !== 0) continue;

        const { width: pageWidth, height: pageHeight } = pages[page].getSize();
        if (pageWidth <= 0 || pageHeight <= 0) continue;

        // `asRectangle` subtracts corner from corner and some producers store
        // them the other way round, so width and height can arrive negative.
        const rect = widget.getRectangle();
        const width = Math.abs(rect.width);
        const height = Math.abs(rect.height);
        const left = Math.min(rect.x, rect.x + rect.width);
        const bottom = Math.min(rect.y, rect.y + rect.height);

        placements.push({
          page,
          left: (left / pageWidth) * 100,
          // PDF measures up from the bottom of the page; the web measures down
          // from the top, and this is the only line that knows it.
          top: ((pageHeight - (bottom + height)) / pageHeight) * 100,
          width: (width / pageWidth) * 100,
          height: (height / pageHeight) * 100,
        });
      }

      return placements;
    };
  };

  /**
   * The box's own printed question, in USCIS's words.
   *
   * `/TU` is the AcroForm alternate description — what a screen reader says.
   * Because these forms are Section 508 compliant, every single box carries one
   * (450 of 450 on the I-130, 760 of 760 on the I-485), and it is the *printed*
   * question, part heading and item number included:
   *
   *     Part 9. General Eligibility and Inadmissibility Grounds. 13. Have you
   *     EVER violated the terms or conditions of your nonimmigrant status?
   *     Select No.
   *
   * That is worth far more than anything derivable from the box's name. It also
   * settles disagreements the name cannot: on the I-485 the box called `Pt8...`
   * sits in printed Part 9, and only the tooltip knows.
   */
  private tooltipOf = (field: { acroField: { dict: PDFDict } }) => {
    const tu = field.acroField.dict.get(PDFName.of("TU"));
    if (tu instanceof PDFString || tu instanceof PDFHexString) {
      // Wrapped across lines in the source; a single line is what a label is.
      return tu.decodeText().replace(/\s+/g, " ").trim();
    }
    return null;
  };

  /**
   * The form's official blank, as the government prints it.
   *
   * ─── Why nothing is written into it ───────────────────────────────────────
   *
   * This used to stamp each mapped box with the field key that claims it, so
   * that pointing `beneficiary.family_name` one box too low would be visible.
   * It made the preview unreadable as a form: an operator checking the I-485
   * against USCIS's own blank was reading 400 boxes of `beneficiary.*` instead
   * of the document, and the one view of the real paper was gone.
   *
   * So the blank is the blank. The mapping is checked on the PDF boxes screen,
   * which lists every box with the datum that claims it and is the place to
   * change one; what the counts here say is how much of the form that screen
   * still has to account for.
   *
   * Loaded through `loadBlank` rather than served off disk, because the file
   * as USCIS ships it does not render reliably — see `openBlank`, which drops
   * the encryption remnants and the rich-text flags before it is saved back
   * out.
   */
  previewBlank = async (formCode: string) => {
    const edition = await this.currentEdition(formCode);
    const [doc, mappings, boxes] = await Promise.all([
      this.loadBlank(edition),
      this.mappingsForEdition(edition.id),
      this.listBoxes(formCode),
    ]);

    // Counted over distinct boxes, not mapping rows. One datum may print into
    // several boxes, so rows outnumber boxes on a form like the I-130 and
    // "412 of 512 boxes mapped" would otherwise be able to exceed its total.
    const claimed = new Set(mappings.map((m) => m.pdfFieldName));

    return {
      bytes: Buffer.from(await doc.save()),
      edition,
      mapped: claimed.size,
      boxes: boxes.length,
      unmapped: boxes.filter((box) => !claimed.has(box.name)).length,
    };
  };

  /**
   * Which datum prints into which box, for one form's current edition.
   *
   * `partLabel` narrows it to the part the screen is showing — see
   * `catalogueFields` for what its three states mean. Filtered here rather than
   * in SQL because the mappings are keyed by field key and the parts are on the
   * field definitions: one small join in memory against a list the caller is
   * about to render anyway.
   */
  getMappings = async (formCode: string, partLabel?: string | null) => {
    const edition = await this.currentEdition(formCode);
    const mappings = await this.mappingsForEdition(edition.id);
    if (partLabel === undefined) return { edition, mappings };

    const inPart = new Set(
      (await catalogueFields(formCode, partLabel)).map((f) => f.fieldKey),
    );
    return { edition, mappings: mappings.filter((m) => inPart.has(m.fieldKey)) };
  };

  /**
   * Where each of a form's data prints, as rectangles on numbered pages.
   *
   * ─── Why the firm gets this at all ──────────────────────────────────────
   *
   * The Forms tab renders the filled PDF a page at a time and draws the
   * reviewing attorney's marks on it, so a mark can be placed by pointing at
   * the box rather than by finding the field's name in a list of 512. That
   * needs two things joined — where a box is, and which datum prints into it —
   * and only the server holds either.
   *
   * ─── Joined here, not on the client ─────────────────────────────────────
   *
   * The alternative was to ship the boxes and the mappings separately and let
   * the browser join them, which is what the CRM's mapper does — because the
   * mapper is *editing* that join and needs both sides whole, including the
   * boxes nothing claims. A reader does not: an unmapped box is not a field, so
   * it cannot be marked, and sending 736 of them to be discarded is most of the
   * payload.
   *
   * A datum may print into several boxes — the I-130 asks the date of marriage
   * in Part 2 and again in Part 4 — so this is a list of placements per field
   * key rather than one each. Both print, and a mark on that field should be
   * visible wherever the reader is looking.
   *
   * Percentages of the page, like every other placement in this service: the
   * client renders at whatever width its pane happens to be. See
   * `placementReader` for the geometry and for what a rotated page does.
   */
  fieldPlacements = async (formCode: string) => {
    const { edition, mappings } = await this.getMappings(formCode);
    const boxes = this.boxesOf(await this.loadBlank(edition));

    const placementsByBox = new Map(
      boxes.map((box) => [box.name, box.placements]),
    );

    const byField = new Map<string, BoxPlacement[]>();
    for (const mapping of mappings) {
      const placements = placementsByBox.get(mapping.pdfFieldName);
      // A mapping naming a box this edition does not have. Legitimate while a
      // new blank is being wired up, and nothing a reader can act on — the
      // seed report is where it is somebody's job.
      if (!placements?.length) continue;
      byField.set(mapping.fieldKey, [
        ...(byField.get(mapping.fieldKey) ?? []),
        ...placements,
      ]);
    }

    return [...byField].map(([fieldKey, placements]) => ({
      fieldKey,
      placements,
    }));
  };

  /**
   * Which data print into at least one box on the edition in force.
   *
   * Empty rather than an error when no edition is on record: a form can be
   * catalogued before its blank is, and what asks this is a count beside a
   * part's name — a page that 404s because one number is unknowable is worse
   * than a zero.
   */
  mappedFieldKeys = async (formCode: string): Promise<Set<string>> => {
    try {
      const { mappings } = await this.getMappings(formCode);
      return new Set(mappings.map((m) => m.fieldKey));
    } catch (error) {
      if (error instanceof NotFoundError) return new Set();
      throw error;
    }
  };

  private mappingsForEdition = (editionId: string) =>
    db
      .select()
      .from(formPdfFieldMappings)
      .where(eq(formPdfFieldMappings.formEditionId, editionId));

  /**
   * Point a datum at a box, or clear it.
   *
   * One statement per field rather than a bulk replace, so a half-finished
   * mapping session leaves the boxes already mapped exactly as they were.
   *
   * `fieldValue` names *which answer* the box is for, and is what makes a
   * choice mappable at all: `beneficiary.sex` needs one box for "Male" and
   * another for "Female", so it is addressed as two mappings that differ only
   * here. Null is the whole datum — a text box, or a dropdown.
   */
  setMapping = async (
    formCode: string,
    fieldKey: string,
    pdfFieldName: string | null,
    fieldValue: string | null = null,
  ) => {
    const edition = await this.currentEdition(formCode);

    // Which row this addresses: the datum, or one answer of it.
    const addresses = and(
      eq(formPdfFieldMappings.formEditionId, edition.id),
      eq(formPdfFieldMappings.fieldKey, fieldKey),
      fieldValue === null
        ? isNull(formPdfFieldMappings.fieldValue)
        : eq(formPdfFieldMappings.fieldValue, fieldValue),
    );

    if (!pdfFieldName) {
      await db.delete(formPdfFieldMappings).where(addresses);
      return { cleared: true };
    }

    // A box can hold one datum, so pointing a second one at it would otherwise
    // fail on the unique constraint with nothing useful to say.
    await db
      .delete(formPdfFieldMappings)
      .where(
        and(
          eq(formPdfFieldMappings.formEditionId, edition.id),
          eq(formPdfFieldMappings.pdfFieldName, pdfFieldName),
        ),
      );

    // Upserting on the box rather than on the field: a choice has several rows
    // sharing a field key, and the box is the only column unique across them.
    // The row this call addresses is cleared first so the insert cannot collide
    // with the answer's previous box.
    await db.delete(formPdfFieldMappings).where(addresses);

    await db
      .insert(formPdfFieldMappings)
      .values({ formEditionId: edition.id, fieldKey, pdfFieldName, fieldValue })
      .onConflictDoUpdate({
        target: [
          formPdfFieldMappings.formEditionId,
          formPdfFieldMappings.pdfFieldName,
        ],
        set: { fieldKey, fieldValue, updatedAt: new Date() },
      });

    return { cleared: false };
  };

  /**
   * The matter's answers for one form, keyed by field key.
   *
   * Firm and matter-scoped definitions override the platform's, the same way
   * they do everywhere else in the catalogue.
   */
  private valuesForCaseForm = async (
    organizationId: string,
    caseId: string,
    formCode: string,
  ) => {
    const [form] = await db
      .select({ id: caseForms.id })
      .from(caseForms)
      .where(
        and(
          eq(caseForms.caseId, caseId),
          eq(caseForms.formCode, formCode),
          eq(caseForms.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!form) throw new NotFoundError(`${formCode} is not on this matter`);

    const rows = await db
      .select({
        fieldKey: caseFormFieldValues.fieldKey,
        value: caseFormFieldValues.value,
      })
      .from(caseFormFieldValues)
      .where(eq(caseFormFieldValues.caseFormId, form.id));

    const values = new Map<string, unknown>();
    for (const row of rows) values.set(row.fieldKey, row.value);
    return values;
  };

  /** The field types for a form, so a value is written the way its box expects. */
  private typesForForm = async (organizationId: string, formCode: string) => {
    const rows = await db
      .select({
        fieldKey: formFieldDefinitions.fieldKey,
        type: formFieldDefinitions.type,
      })
      .from(formFieldDefinitions)
      .where(eq(formFieldDefinitions.formCode, formCode));

    const types = new Map<string, string>();
    for (const row of rows) types.set(row.fieldKey, row.type);
    return types;
  };

  /**
   * The matter's copy of a form, as a filled PDF.
   *
   * Returns the bytes and a report of what could not be written, because a
   * silently half-filled filing is the failure mode that matters here. A box
   * that rejects its value is named rather than swallowed.
   */
  fillForCase = async (
    organizationId: string,
    caseId: string,
    formCode: string,
    options: { flatten?: boolean } = {},
  ) => {
    // One edition lookup for both halves. Resolving them separately would let
    // the blank and the mappings come from different editions if the acceptance
    // window turned over mid-request — rare, and silently wrong.
    const edition = await this.currentEdition(formCode);

    const [doc, mappings, values, types, repeatGroups] = await Promise.all([
      this.loadBlank(edition),
      this.mappingsForEdition(edition.id),
      this.valuesForCaseForm(organizationId, caseId, formCode),
      this.typesForForm(organizationId, formCode),
      repeatGroupsForCase(caseId, organizationId),
    ]);

    if (mappings.length === 0) {
      throw new BadRequestError(
        `${formCode} has no PDF field mappings yet, so there is nothing to print into. Map its fields first.`,
      );
    }

    const form = doc.getForm();
    const skipped: { fieldKey: string; box: string; why: string }[] = [];
    let written = 0;

    // Grouped, because a datum can own several boxes: a choice is printed as
    // one checkbox per option, and answering it means marking one of them and
    // clearing the rest.
    const byField = new Map<string, typeof mappings>();
    for (const mapping of mappings) {
      const group = byField.get(mapping.fieldKey);
      if (group) group.push(mapping);
      else byField.set(mapping.fieldKey, [mapping]);
    }

    for (const [fieldKey, group] of byField) {
      const raw = values.get(fieldKey);
      if (raw == null || raw === "") continue;

      const text = this.asText(raw, types.get(fieldKey));
      const marks = group.filter((m) => m.fieldValue != null);

      if (marks.length > 0) {
        written += this.markChoice(form, fieldKey, text, marks, skipped);
        continue;
      }

      // One value, into every box that asks for it. Usually that is one box.
      // It is two on the I-130, which wants the date of the marriage in Part 2
      // from the petitioner and again in Part 4 from the beneficiary — and a
      // filing with the second one blank is one USCIS reads as unanswered.
      for (const mapping of group) {
        try {
          const field = form.getField(mapping.pdfFieldName);

          if (field instanceof PDFTextField) {
            field.setText(text);
          } else if (field instanceof PDFDropdown) {
            field.select(text);
          } else {
            // A checkbox with no answer recorded against it cannot be marked
            // sensibly — "which box does this tick?" has no answer. Saying so
            // beats ticking whichever box the mapping happened to name.
            skipped.push({
              fieldKey,
              box: mapping.pdfFieldName,
              why: "a mark-type box with no answer recorded against it; re-run the extractor for this form",
            });
            continue;
          }
          written += 1;
        } catch (error) {
          skipped.push({
            fieldKey,
            box: mapping.pdfFieldName,
            why:
              error instanceof Error ? error.message : "could not be written",
          });
        }
      }
    }

    /*
      Whatever the blank had no room for goes on its Additional Information
      part. This runs after the ordinary pass and before flattening, and it is
      not optional: a client third address dropped in silence is read by USCIS
      as an address that was not disclosed. See `continuation-sheet.ts`.
    */
    const overflow = continuationBlocks({
      mappings,
      groups: repeatGroups,
      pageOfBox: this.pageOfBox(doc),
    });
    const continued = fillContinuation(doc, overflow);
    written += continued.written;

    // Flattening burns the values into the page so nothing can be typed over
    // them afterwards. Right for a filing, wrong for a draft somebody is still
    // checking, so the caller decides.
    if (options.flatten) form.flatten();

    return {
      bytes: Buffer.from(await doc.save()),
      written,
      mapped: mappings.length,
      skipped,
      /*
        Entries that overflowed the continuation sheet as well. The paralegal
        has to type a plain-paper sheet for these — USCIS scans these forms
        against a page template, so inventing a page is a rejection — and the
        only unacceptable outcome is not telling them.
      */
      unplaced: continued.unplaced,
    };
  };

  /**
   * The whole package as one PDF, in the order it is filed.
   *
   * ─── Why this is not "print each form and staple them" ────────────────────
   *
   * It is, mechanically. What it is not is a client-side loop over six
   * downloads. A filing goes to USCIS as one assembled package, and the two
   * things that make it a package rather than six files — the order and the
   * completeness — are exactly what a person clicking six times gets wrong.
   * Order comes from `case_type_forms`, the same rows the CRM edits, so the
   * paper comes out in the sequence the package was designed in.
   *
   * ─── One bad form does not take the package with it ───────────────────────
   *
   * A form with no mappings yet, or no blank on disk, throws in `fillForCase`.
   * Failing the whole render there would leave a paralegal with nothing and no
   * way to tell which form was at fault, so each is caught and reported by name
   * in `failed`. A package that is missing a form is a fact the caller has to
   * see; a package that will not render at all is a dead end.
   */
  fillPackageForCase = async (
    organizationId: string,
    caseId: string,
    options: { flatten?: boolean } = {},
  ) => {
    // The package as the CRM designed it, which is where the order comes from.
    const order = (await defaultPackageFor(caseId, organizationId)).map(
      (form) => form.formCode,
    );

    const rows = await db
      .select({ formCode: caseForms.formCode })
      .from(caseForms)
      .where(
        and(
          eq(caseForms.caseId, caseId),
          eq(caseForms.organizationId, organizationId),
        ),
      );

    if (rows.length === 0) {
      throw new BadRequestError("This matter has no forms on it yet");
    }

    /*
      Package order first, then anything the package does not name.

      A form added to one matter by hand — an I-601 waiver nobody could have
      predicted — is not in `case_type_forms` and has no order. Sorting it to
      the end keeps it in the package rather than dropping it, which is the
      only answer that cannot lose paper.
    */
    const rank = (formCode: string) => {
      const index = order.indexOf(formCode);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    const forms = [...rows].sort(
      (a, b) =>
        rank(a.formCode) - rank(b.formCode) ||
        a.formCode.localeCompare(b.formCode),
    );

    /*
      Forms somebody outside the firm completes are left out of the merge.

      The I-693 is the case that matters: a civil surgeon fills it, signs it and
      seals it in an envelope nobody may open. Printing our own blank copy of it
      into the package would produce a filing that looks complete and is not —
      which is exactly what USCIS rejects. So the form is named in `provided`,
      with the instruction, and the paper it stands for is added by hand.
    */
    const catalogue = await listCatalogueForms();
    const providedBy = new Map(
      catalogue
        .filter((form) => form.providedBy)
        .map((form) => [form.formCode, form.providedBy!] as const),
    );

    const merged = await PDFDocument.create();
    const included: { formCode: string; pages: number; written: number }[] = [];
    const failed: { formCode: string; why: string }[] = [];
    const provided: { formCode: string; instruction: string }[] = [];
    const unplaced: ContinuationBlock[] = [];

    for (const { formCode } of forms) {
      const instruction = providedBy.get(formCode);
      if (instruction) {
        provided.push({ formCode, instruction });
        continue;
      }

      try {
        const filled = await this.fillForCase(
          organizationId,
          caseId,
          formCode,
          options,
        );

        const source = await PDFDocument.load(filled.bytes);
        const pages = await merged.copyPages(source, source.getPageIndices());
        for (const page of pages) merged.addPage(page);

        included.push({
          formCode,
          pages: pages.length,
          written: filled.written,
        });
        unplaced.push(...filled.unplaced);
      } catch (error) {
        failed.push({
          formCode,
          why: error instanceof Error ? error.message : "could not be rendered",
        });
      }
    }

    if (included.length === 0) {
      throw new BadRequestError(
        `No form on this matter could be rendered: ${failed
          .map((f) => `${f.formCode} (${f.why})`)
          .join("; ")}`,
      );
    }

    return {
      bytes: Buffer.from(await merged.save()),
      included,
      failed,
      provided,
      unplaced,
    };
  };

  /**
   * Mark the box that matches the answer, and clear the ones that do not.
   *
   * ─── Why every sibling is cleared, not just the matching one marked ───────
   *
   * The blank arrives with nothing ticked, but a form is filled more than once
   * — a client corrects an answer, a paralegal changes it — and a choice that
   * only ever added ticks would end up with two options marked and no record of
   * which was meant. USCIS reads that as an incomplete form.
   *
   * ─── Why an unmatched answer is loud ──────────────────────────────────────
   *
   * Because the alternative was this bug. When a choice held one box for all
   * its options, answering "Parent" fell through to "not a yes, so untick",
   * ticked nothing, and reported success — a form filed with an unanswered
   * question and nothing anywhere saying so.
   */
  private markChoice = (
    form: ReturnType<PDFDocument["getForm"]>,
    fieldKey: string,
    answer: string,
    marks: { pdfFieldName: string; fieldValue: string | null }[],
    skipped: { fieldKey: string; box: string; why: string }[],
  ) => {
    let matched = false;
    let written = 0;

    for (const mark of marks) {
      try {
        const field = form.getField(mark.pdfFieldName);
        if (!(field instanceof PDFCheckBox)) {
          skipped.push({
            fieldKey,
            box: mark.pdfFieldName,
            why: `expected a checkbox for "${mark.fieldValue}" and found ${field.constructor.name}`,
          });
          continue;
        }

        if (sameAnswer(mark.fieldValue ?? "", answer)) {
          field.check();
          matched = true;
          written += 1;
        } else {
          field.uncheck();
        }
      } catch (error) {
        skipped.push({
          fieldKey,
          box: mark.pdfFieldName,
          why: error instanceof Error ? error.message : "could not be marked",
        });
      }
    }

    if (!matched) {
      skipped.push({
        fieldKey,
        box: marks.map((m) => m.fieldValue).join(" / "),
        why: `no box on this form is marked by the answer "${answer}"`,
      });
    }

    return written;
  };

  /**
   * Which page each box sits on, by full field name.
   *
   * The continuation sheet says "this continues page N", and N is a property of
   * the paper rather than of any row in the database — only the opened PDF
   * knows it.
   */
  private pageOfBox = (doc: PDFDocument) => {
    const pageIndex = new Map(
      doc.getPages().map((page, index) => [page.ref.tag, index]),
    );

    const pages = new Map<string, number>();
    for (const field of doc.getForm().getFields()) {
      for (const widget of field.acroField.getWidgets()) {
        const parent = widget.P();
        const page = parent ? pageIndex.get(parent.tag) : undefined;
        if (page !== undefined) pages.set(field.getName(), page);
      }
    }
    return pages;
  };

  /**
   * A stored answer as the string a PDF box takes.
   *
   * Dates are the only real conversion: answers are held ISO, and every date
   * box on a USCIS form is printed mm/dd/yyyy.
   */
  private asText = (value: unknown, type?: string) => {
    if (typeof value === "boolean") return value ? "Y" : "N";
    const text = String(value);

    if (type === "date") {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
      if (match) return `${match[2]}/${match[3]}/${match[1]}`;
    }
    return text;
  };
}

export const formPdfService = new FormPdfService();
