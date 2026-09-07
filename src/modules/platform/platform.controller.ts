import type { Request, Response } from "express";

import { getRequestContext } from "../../middleware/request-context";
import type { AuditActionName } from "../../lib/audit/actions";
import type { TaxonomyStatus } from "../../db/schema/taxonomy-status";
import asyncWrap from "../../utils/asyncWrapper";
import { AuthorizationError, BadRequestError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { recordAuditEvent } from "../shared/audit.service";
import {
  addCatalogueField,
  addCatalogueForm,
  catalogueFields,
  catalogueForm,
  deleteCatalogueField,
  deleteCatalogueForm,
  deleteFormPart,
  formPracticeAreasOf,
  renameFormPart,
  reorderCatalogueFields,
  updateCatalogueField,
  upsertFormPart,
  updateCatalogueForm,
} from "../workflow/form-catalogue.service";
import {
  clearFormFieldMapping,
  formParts,
  formSourceQuestions,
  getFormFieldMap,
  setFormFieldMapping,
  setFormFieldMappings,
} from "../workflow/form-mappings.service";
import { formPdfService } from "../workflow/form-pdf.service";
import {
  formFiledOn,
  getPlatformAdmin,
  listCatalogueOverview,
} from "./platform.service";
import {
  addEdition,
  importCatalogue,
  listEditions,
  previewImport,
  updateEdition,
  uploadBlank,
} from "./form-blanks.service";
import {
  createCaseType,
  createPracticeArea,
  createSubcategory,
  deleteCaseType,
  deletePracticeArea,
  deleteSubcategory,
  getCaseType,
  getPracticeArea,
  getSubcategory,
  listCaseTypes,
  listFormsForCaseType,
  listPracticeAreas,
  listSubcategories,
  removeCaseTypeForm,
  reorderCaseTypeForms,
  setCaseTypeForm,
  taxonomyCounts,
  updateCaseType,
  updatePracticeArea,
  updateSubcategory,
} from "./taxonomy.service";

/**
 * Which part of a form a request is about, off the query string.
 *
 * Three answers, matching `catalogueFields`: absent is the whole form, a
 * string is that part, and `?part=` with nothing after it is the part of a
 * form whose fields carry no label — a real part on a one-page form, and the
 * only thing a query string can use to say null.
 */
const partOf = (req: Request) =>
  req.query.part === undefined ? undefined : String(req.query.part) || null;

/**
 * Records a catalogue change under the `platform.*` vocabulary.
 *
 * `organizationId: null` is the point, not an oversight: these events belong
 * to no firm because the change belongs to no firm. One of them alters every
 * firm's copy of a form, and filing it under whichever tenant happened to be
 * in context would hide exactly that.
 */
const audit = (
  action: AuditActionName,
  entityId: string | null,
  summary: string,
  metadata: Record<string, unknown> = {},
) =>
  recordAuditEvent({
    action,
    entityId,
    organizationId: null,
    summary,
    metadata,
  });

/** The three taxonomy levels, as they appear in the audit vocabulary. */
type TaxonomyNode = "practice_area" | "subcategory" | "case_type";

/**
 * Which of a level's three update actions a patch actually is.
 *
 * Archiving is the change somebody comes back to the trail looking for — "when
 * did we stop offering this, and who decided?" — so it gets its own action
 * rather than hiding inside a generic `updated` behind a metadata field nobody
 * expands. A patch that renames *and* archives in one request is filed as the
 * archive; the new name is in the metadata either way.
 */
const taxonomyUpdateAction = (
  node: TaxonomyNode,
  patch: { status?: TaxonomyStatus },
): AuditActionName => {
  if (patch.status === "archived") return `platform.${node}_archived`;
  if (patch.status === "active") return `platform.${node}_restored`;
  return `platform.${node}_updated`;
};

/**
 * The sentence the trail keeps.
 *
 * Written now, in today's vocabulary, because that is what a summary is for —
 * a sentence rebuilt from a later build would describe the change in words
 * that were not in use when it happened.
 */
const describePatch = (
  name: string,
  patch: { status?: TaxonomyStatus; name?: string },
) => {
  if (patch.status === "archived") return `${name} archived — no longer offered`;
  if (patch.status === "active") return `${name} restored`;
  if (patch.name) return `Renamed to ${patch.name}`;
  return `${name} updated`;
};

/**
 * The CRM's handlers.
 *
 * Every one of these operates on content that is identical for every firm in
 * the deployment. Nothing here takes a `caseId`, and that absence is the
 * clearest statement of the boundary: if a request needs to name a matter, it
 * belongs on `/cases`, not here.
 *
 * The services behind them are the same ones the firm app reads through —
 * `form-catalogue.service` in particular is shared, so a firm's Forms tab and
 * this screen can never drift about what is on an I-485.
 */
export class PlatformController {
  /**
   * Who the CRM is talking to.
   *
   * The frontend's `PlatformGuard` re-derives access from the auth store, the
   * same way `AdminGuard` does; this is what it re-derives it *from* once the
   * session is established, and it is the cheapest possible smoke test that
   * the whole tier is wired — sign in, call this, get a name back.
   */
  getMe = asyncWrap(async (_req: Request, res: Response) => {
    const { userId } = getRequestContext();
    if (!userId) throw new AuthorizationError("Not found");

    sendSuccess(res, await getPlatformAdmin(userId));
  }, "platform.getMe");

  // ─── The taxonomy: practice area → subcategory → case type ───────────────

  /**
   * How big the taxonomy is, and how much of it has a package.
   *
   * The gap between `caseTypes` and `caseTypesWithForms` is the tier's real
   * backlog — 687 leaves, and only the ones Oravanti has configured file
   * anything.
   */
  taxonomyCounts = asyncWrap(async (_req: Request, res: Response) => {
    sendSuccess(res, await taxonomyCounts());
  }, "platform.taxonomyCounts");

  listPracticeAreas = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(res, await listPracticeAreas(req.query as never));
  }, "platform.listPracticeAreas");

  listSubcategories = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await listSubcategories(String(req.params.practiceAreaId), req.query as never),
    );
  }, "platform.listSubcategories");

  listCaseTypes = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await listCaseTypes(String(req.params.subcategoryId), req.query as never),
    );
  }, "platform.listCaseTypes");

  /** One case type: where it sits, what it files, and what it asks. */
  getCaseType = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(res, await getCaseType(String(req.params.caseTypeId)));
  }, "platform.getCaseType");

  /** The catalogue minus what is already on this package, for the picker. */
  listFormsForCaseType = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await listFormsForCaseType(String(req.params.caseTypeId), req.query as never),
    );
  }, "platform.listFormsForCaseType");

  /*
    The three writes below change what every firm's *next* matter of this type
    is provisioned with. They do not touch matters that already exist —
    `ensurePackageForms` is additive and runs at materialization — which is why
    the audit summaries name the case type rather than a number of matters.
  */

  setCaseTypeForm = asyncWrap(async (req: Request, res: Response) => {
    const caseTypeId = String(req.params.caseTypeId);
    const { formCode, role } = req.body;
    const result = await setCaseTypeForm({ caseTypeId, formCode, role });

    await audit(
      "platform.case_type_form_set",
      caseTypeId,
      `${formCode} is a ${role} form on ${result.caseType.name}`,
      { caseTypeId, caseTypeName: result.caseType.name, formCode, role },
    );

    sendSuccess(res, result.form, "Form added to the package");
  }, "platform.setCaseTypeForm");

  removeCaseTypeForm = asyncWrap(async (req: Request, res: Response) => {
    const caseTypeId = String(req.params.caseTypeId);
    const formCode = String(req.params.formCode);
    const removed = await removeCaseTypeForm(caseTypeId, formCode);

    await audit(
      "platform.case_type_form_removed",
      caseTypeId,
      `${formCode} is no longer filed by this case type`,
      { caseTypeId, formCode, role: removed.role },
    );

    sendSuccess(res, removed, "Form removed from the package");
  }, "platform.removeCaseTypeForm");

  reorderCaseTypeForms = asyncWrap(async (req: Request, res: Response) => {
    const caseTypeId = String(req.params.caseTypeId);
    const result = await reorderCaseTypeForms(caseTypeId, req.body.formCodes);

    await audit(
      "platform.case_type_forms_reordered",
      caseTypeId,
      `Filing order set to ${result.formCodes.join(", ")}`,
      { caseTypeId, formCodes: result.formCodes },
    );

    sendSuccess(res, result, "Filing order saved");
  }, "platform.reorderCaseTypeForms");

  // ─── Writing the taxonomy ────────────────────────────────────────────────
  //
  // The CMS is where the taxonomy is maintained once the seed has bootstrapped
  // it. Every handler below files its event with `organizationId: null` for the
  // reason the `audit` helper gives: one of these changes what every firm on
  // the deployment can open a matter under.

  getPracticeArea = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(res, await getPracticeArea(String(req.params.practiceAreaId)));
  }, "platform.getPracticeArea");

  createPracticeArea = asyncWrap(async (req: Request, res: Response) => {
    const area = await createPracticeArea(req.body);

    await audit("platform.practice_area_created", area.id, `${area.name} added`, {
      name: area.name,
    });

    sendSuccess(res, area, "Practice area created");
  }, "platform.createPracticeArea");

  updatePracticeArea = asyncWrap(async (req: Request, res: Response) => {
    const area = await updatePracticeArea(
      String(req.params.practiceAreaId),
      req.body,
    );

    await audit(
      taxonomyUpdateAction("practice_area", req.body),
      area.id,
      describePatch(area.name, req.body),
      req.body,
    );

    sendSuccess(res, area, "Practice area saved");
  }, "platform.updatePracticeArea");

  deletePracticeArea = asyncWrap(async (req: Request, res: Response) => {
    const area = await deletePracticeArea(String(req.params.practiceAreaId));

    await audit("platform.practice_area_deleted", area.id, `${area.name} deleted`, {
      name: area.name,
    });

    sendSuccess(res, area, "Practice area deleted");
  }, "platform.deletePracticeArea");

  getSubcategory = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(res, await getSubcategory(String(req.params.subcategoryId)));
  }, "platform.getSubcategory");

  createSubcategory = asyncWrap(async (req: Request, res: Response) => {
    const { subcategory, practiceArea } = await createSubcategory({
      practiceAreaId: String(req.params.practiceAreaId),
      ...req.body,
    });

    await audit(
      "platform.subcategory_created",
      subcategory.id,
      `${subcategory.name} added under ${practiceArea.name}`,
      {
        name: subcategory.name,
        code: subcategory.code,
        practiceAreaId: practiceArea.id,
      },
    );

    sendSuccess(res, subcategory, "Subcategory created");
  }, "platform.createSubcategory");

  updateSubcategory = asyncWrap(async (req: Request, res: Response) => {
    const subcategory = await updateSubcategory(
      String(req.params.subcategoryId),
      req.body,
    );

    await audit(
      taxonomyUpdateAction("subcategory", req.body),
      subcategory.id,
      describePatch(subcategory.name, req.body),
      req.body,
    );

    sendSuccess(res, subcategory, "Subcategory saved");
  }, "platform.updateSubcategory");

  deleteSubcategory = asyncWrap(async (req: Request, res: Response) => {
    const subcategory = await deleteSubcategory(String(req.params.subcategoryId));

    await audit(
      "platform.subcategory_deleted",
      subcategory.id,
      `${subcategory.name} deleted`,
      { name: subcategory.name, code: subcategory.code },
    );

    sendSuccess(res, subcategory, "Subcategory deleted");
  }, "platform.deleteSubcategory");

  createCaseType = asyncWrap(async (req: Request, res: Response) => {
    const { caseType, subcategory } = await createCaseType({
      subcategoryId: String(req.params.subcategoryId),
      ...req.body,
    });

    await audit(
      "platform.case_type_created",
      caseType.id,
      `${caseType.name} added under ${subcategory.name}`,
      { name: caseType.name, code: caseType.code, subcategoryId: subcategory.id },
    );

    sendSuccess(res, caseType, "Case type created");
  }, "platform.createCaseType");

  updateCaseType = asyncWrap(async (req: Request, res: Response) => {
    const caseType = await updateCaseType(String(req.params.caseTypeId), req.body);

    await audit(
      taxonomyUpdateAction("case_type", req.body),
      caseType.id,
      describePatch(caseType.name, req.body),
      req.body,
    );

    sendSuccess(res, caseType, "Case type saved");
  }, "platform.updateCaseType");

  deleteCaseType = asyncWrap(async (req: Request, res: Response) => {
    const caseType = await deleteCaseType(String(req.params.caseTypeId));

    await audit(
      "platform.case_type_deleted",
      caseType.id,
      `${caseType.name} deleted`,
      { name: caseType.name, code: caseType.code },
    );

    sendSuccess(res, caseType, "Case type deleted");
  }, "platform.deleteCaseType");

  // ─── The form catalogue ──────────────────────────────────────────────────

  /**
   * The catalogue, with coverage and edition beside each form.
   *
   * Richer than `listCatalogueForms`, which the firm-facing rail still reads:
   * this is the CRM's landing view, and "how much of the I-485 is wired up, and
   * when does its edition lapse" is the question it exists to answer.
   */
  listForms = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(res, await listCatalogueOverview(req.query as never));
  }, "platform.listForms");

  /**
   * One form, its parts, and where it is filed from.
   *
   * Parts rather than fields: the three views below all read a part at a time,
   * so this is the index they navigate by — names and counts, not 512 rows of
   * field definition nobody has asked to see yet.
   *
   * `filedOn` is the answer to the question the Forms page cannot ask: a form
   * has no owning practice area, so the only way to know a change to the I-864
   * reaches family *and* employment matters is to list the packages naming it.
   * Read in one response rather than a second request, because it is the
   * context for everything else on the page rather than a tab of its own.
   */
  getForm = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const [form, parts, filedOn, practiceAreas] = await Promise.all([
      catalogueForm(formCode),
      formParts(formCode),
      formFiledOn(formCode),
      formPracticeAreasOf(formCode),
    ]);
    sendSuccess(res, { form, parts, filedOn, practiceAreas });
  }, "platform.getForm");

  /**
   * Names a form, and says which practice areas it is for.
   *
   * Two tables and two decisions, composed here rather than inside
   * `addCatalogueForm` so `form_definitions` never learns about the taxonomy.
   *
   * What it deliberately does *not* write is a filing package. An operator
   * naming a form knows the practice area at once and does not yet know which
   * of the 150 matter types under it will file it — and turning "Immigration"
   * into 150 `case_type_forms` rows would put the form on every matter opened
   * afterwards. That decision stays on the matter type's own page, where the
   * rest of its package is visible.
   *
   * The area rows are written after the form exists and are not rolled back if
   * one fails. A form classified under nothing is an ordinary state the list
   * renders plainly; a classification naming no form is not.
   */
  addForm = asyncWrap(async (req: Request, res: Response) => {
    const { practiceAreaIds = [], ...form } = req.body as {
      practiceAreaIds?: string[];
    } & Parameters<typeof addCatalogueForm>[0]["form"];

    const created = await addCatalogueForm({ form, practiceAreaIds });

    await audit(
      "platform.form_created",
      created.id,
      `${created.formCode} (${created.title}) added to the catalogue`,
      { formCode: created.formCode, practiceAreas: practiceAreaIds.length },
    );

    sendSuccess(res, created, `${created.formCode} added to the catalogue`, 201);
  }, "platform.addForm");

  updateForm = asyncWrap(async (req: Request, res: Response) => {
    // Split here rather than in the service, for the same reason `addForm`
    // composes the two writes: `form_definitions` never learns about the
    // taxonomy.
    const { practiceAreaIds, ...patch } = req.body as {
      practiceAreaIds?: string[];
    } & Record<string, unknown>;

    const updated = await updateCatalogueForm({
      formDefinitionId: String(req.params.definitionId),
      patch,
      practiceAreaIds,
    });

    await audit(
      "platform.form_updated",
      updated.id,
      `${updated.formCode} reworded to "${updated.title}"`,
      { formCode: updated.formCode },
    );

    sendSuccess(res, updated, "Form updated");
  }, "platform.updateForm");

  deleteForm = asyncWrap(async (req: Request, res: Response) => {
    const definitionId = String(req.params.definitionId);
    const result = await deleteCatalogueForm({ formDefinitionId: definitionId });

    await audit(
      "platform.form_deleted",
      definitionId,
      `${result.formCode} removed from the catalogue, with its fields`,
      { formCode: result.formCode },
    );

    sendSuccess(res, result, `${result.formCode} removed from the catalogue`);
  }, "platform.deleteForm");

  listFields = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await catalogueFields(String(req.params.formCode), partOf(req)),
    );
  }, "platform.listFields");

  addField = asyncWrap(async (req: Request, res: Response) => {
    const created = await addCatalogueField({
      formCode: String(req.params.formCode),
      field: req.body,
    });

    await audit(
      "platform.form_field_created",
      created.id,
      `${created.label} added to ${created.formCode}`,
      { formCode: created.formCode, fieldKey: created.fieldKey },
    );

    sendSuccess(res, created, "Field added", 201);
  }, "platform.addField");

  updateField = asyncWrap(async (req: Request, res: Response) => {
    const updated = await updateCatalogueField({
      fieldDefinitionId: String(req.params.definitionId),
      patch: req.body,
    });

    await audit(
      "platform.form_field_updated",
      updated.id,
      `${updated.fieldKey} on ${updated.formCode} reworded to "${updated.label}"`,
      { formCode: updated.formCode, fieldKey: updated.fieldKey },
    );

    sendSuccess(res, updated, "Field updated");
  }, "platform.updateField");

  deleteField = asyncWrap(async (req: Request, res: Response) => {
    const definitionId = String(req.params.definitionId);
    const formCode = String(req.params.formCode);
    const result = await deleteCatalogueField({ fieldDefinitionId: definitionId });

    await audit(
      "platform.form_field_deleted",
      definitionId,
      `${result.fieldKey} removed from ${formCode}`,
      { formCode, fieldKey: result.fieldKey },
    );

    sendSuccess(res, result, "Field removed");
  }, "platform.deleteField");

  /**
   * Name a part, or describe one.
   *
   * One route for both because it is one write: `form_parts` carries a part's
   * description and, by existing, a part that has no fields yet.
   */
  savePart = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const { partLabel, description } = req.body as {
      partLabel: string;
      description?: string | null;
    };
    const row = await upsertFormPart({ formCode, partLabel, description });

    await audit(
      "platform.form_part_saved",
      row.id,
      `"${partLabel}" on ${formCode} ${description ? "described" : "saved"}`,
      { formCode, partLabel },
    );

    sendSuccess(res, row, "Part saved");
  }, "platform.savePart");

  removePart = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const partLabel = String(req.query.partLabel ?? "");
    const removed = await deleteFormPart({ formCode, partLabel });

    await audit(
      "platform.form_part_deleted",
      null,
      `"${partLabel}" removed from ${formCode}`,
      { formCode, partLabel },
    );

    sendSuccess(res, removed, "Part removed");
  }, "platform.removePart");

  renamePart = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const { from, to } = req.body as { from: string | null; to: string };
    const result = await renameFormPart({ formCode, from, to });

    await audit(
      "platform.form_part_renamed",
      null,
      `${from ?? "The unlabelled part"} on ${formCode} renamed to "${to}" across ${result.fields} field${result.fields === 1 ? "" : "s"}`,
      { formCode, from, to, fields: result.fields },
    );

    sendSuccess(res, result, `Part renamed to "${to}"`);
  }, "platform.renamePart");

  reorderFields = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const result = await reorderCatalogueFields({
      formCode,
      order: req.body.order,
    });

    await audit(
      "platform.form_fields_reordered",
      null,
      `${result.updated} field${result.updated === 1 ? "" : "s"} reordered on ${formCode}`,
      { formCode, updated: result.updated },
    );

    sendSuccess(res, result, "Field order saved");
  }, "platform.reorderFields");

  // ─── Field sources: which question fills which field ─────────────────────

  getFieldMap = asyncWrap(async (req: Request, res: Response) => {
    const result = await getFormFieldMap({
      formCode: String(req.params.formCode),
      partLabel: partOf(req),
      caseTypeId: req.query.caseTypeId ? String(req.query.caseTypeId) : null,
    });
    sendSuccess(res, result);
  }, "platform.getFieldMap");

  /**
   * The questions a field on this form can be pointed at.
   *
   * Its own request because it is the same list for every part, and the field
   * map is read once per part — see `formSourceQuestions`.
   */
  getSourceQuestions = asyncWrap(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await formSourceQuestions(
        req.query.caseTypeId ? String(req.query.caseTypeId) : null,
      ),
    );
  }, "platform.getSourceQuestions");

  setFieldMapping = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const saved = await setFormFieldMapping({
      formCode,
      fieldKey: req.body.fieldKey,
      sourceQuestionId: req.body.sourceQuestionId,
      overrideRationale: req.body.overrideRationale ?? null,
    });

    await audit(
      "platform.field_mapping_set",
      saved.id,
      `${saved.fieldKey} on ${formCode} pointed at a question`,
      {
        formCode,
        fieldKey: saved.fieldKey,
        overridesSharedKey: saved.overridesSharedKey,
      },
    );

    sendSuccess(res, saved, "Field mapped");
  }, "platform.setFieldMapping");

  setFieldMappings = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const { saved, cleared } = await setFormFieldMappings({
      formCode,
      mappings: req.body.mappings,
    });

    const changed = saved + cleared;
    if (changed > 0) {
      await audit(
        "platform.field_mapping_set",
        null,
        `${formCode}: ${saved} field source${saved === 1 ? "" : "s"} set, ${cleared} cleared`,
        { formCode, saved, cleared },
      );
    }

    sendSuccess(
      res,
      { saved, cleared },
      changed === 0
        ? "No changes to save"
        : `${changed} field source${changed === 1 ? "" : "s"} saved`,
    );
  }, "platform.setFieldMappings");

  clearFieldMapping = asyncWrap(async (req: Request, res: Response) => {
    const mappingId = String(req.params.mappingId);
    const removed = await clearFormFieldMapping({ mappingId });

    await audit(
      "platform.field_mapping_cleared",
      mappingId,
      `${removed.fieldKey} on ${removed.formCode} returned to the shared vocabulary`,
      { formCode: removed.formCode, fieldKey: removed.fieldKey },
    );

    sendSuccess(res, null, "Mapping removed");
  }, "platform.clearFieldMapping");

  // ─── PDF boxes: which box on the blank a field prints into ───────────────

  /**
   * Every fillable box on a form's official blank.
   *
   * Read from the PDF itself rather than a stored list, so it cannot drift
   * from the file it describes. These are the targets a field key is pointed
   * at.
   */
  getPdfBoxes = asyncWrap(async (req: Request, res: Response) => {
    const boxes = await formPdfService.listBoxes(String(req.params.formCode));
    sendSuccess(res, { boxes });
  }, "platform.getPdfBoxes");


  /**
   * The form's blank, streamed as a PDF.
   *
   * Inline rather than a download: this is a read view beside the boxes
   * screen, and an operator flips between the two. The counts ride in headers
   * so the page can say `412 of 512 boxes mapped` without parsing the file it
   * just rendered.
   */
  getFormPdfPreview = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const preview = await formPdfService.previewBlank(formCode);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${formCode}.pdf"`,
    );
    res.setHeader("X-Edition-Date", preview.edition.editionDate);
    res.setHeader("X-Boxes", String(preview.boxes));
    res.setHeader("X-Boxes-Mapped", String(preview.mapped));
    res.setHeader("X-Boxes-Unmapped", String(preview.unmapped));
    res.send(preview.bytes);
  }, "platform.getFormPdfPreview");

  /** Which datum prints into which box, for the edition currently in force. */
  getPdfMappings = asyncWrap(async (req: Request, res: Response) => {
    const { edition, mappings } = await formPdfService.getMappings(
      String(req.params.formCode),
      partOf(req),
    );
    sendSuccess(res, {
      editionId: edition.id,
      editionDate: edition.editionDate,
      mappings,
    });
  }, "platform.getPdfMappings");

  setPdfMapping = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const { fieldKey, pdfFieldName, fieldValue } = req.body;
    const result = await formPdfService.setMapping(
      formCode,
      fieldKey,
      pdfFieldName ?? null,
      fieldValue ?? null,
    );

    // Two actions, not one with a flag: "which box does this print into" and
    // "this no longer prints" are different facts to find in a feed later.
    await audit(
      result.cleared ? "platform.pdf_mapping_cleared" : "platform.pdf_mapping_set",
      null,
      result.cleared
        ? `${fieldKey} on ${formCode} no longer prints into a box`
        : `${fieldKey} on ${formCode} prints into ${pdfFieldName}`,
      { formCode, fieldKey, pdfFieldName: pdfFieldName ?? null, fieldValue: fieldValue ?? null },
    );

    sendSuccess(res, result, "PDF mapping saved");
  }, "platform.setPdfMapping");

  // ─── Editions, and the blank each one is filed on ────────────────────────

  /** Every edition of a form, newest first, and whether it has a blank yet. */
  listFormEditions = asyncWrap(async (req: Request, res: Response) => {
    const editions = await listEditions(String(req.params.formCode));
    sendSuccess(res, { editions });
  }, "platform.listFormEditions");

  addFormEdition = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const edition = await addEdition({ formCode, ...req.body });

    await audit(
      "platform.form_edition_created",
      edition.id,
      `${formCode} ${edition.editionDate} edition recorded`,
      { formCode, editionDate: edition.editionDate },
    );

    sendSuccess(res, edition, "Edition recorded", 201);
  }, "platform.addFormEdition");

  updateFormEdition = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const edition = await updateEdition(
      formCode,
      String(req.params.editionId),
      req.body,
    );

    await audit(
      "platform.form_edition_updated",
      edition.id,
      `${formCode} ${edition.editionDate} edition updated`,
      { formCode, editionDate: edition.editionDate, ...req.body },
    );

    sendSuccess(res, edition, "Edition updated");
  }, "platform.updateFormEdition");

  /**
   * Store the official blank against an edition and read its boxes.
   *
   * The response is a *plan*, not a result: nothing about the catalogue has
   * changed. `importFormCatalogue` is what an operator confirms, and it is
   * separate for the reason the whole flow is — these rows decide what prints
   * on a statutory form for every firm in the deployment.
   */
  uploadFormBlank = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const editionId = String(req.params.editionId);
    if (!req.file) {
      throw new BadRequestError("Attach the blank PDF as `blank`.");
    }

    const result = await uploadBlank(formCode, editionId, req.file.buffer);

    if (result.unchanged) {
      sendSuccess(
        res,
        result,
        "That is byte-for-byte the blank already on this edition; nothing changed.",
      );
      return;
    }

    await audit(
      "platform.form_blank_uploaded",
      editionId,
      `Blank uploaded for the ${result.edition.editionDate} edition of ${formCode} (${result.boxes} boxes)`,
      {
        formCode,
        editionDate: result.edition.editionDate,
        boxes: result.boxes,
        bytes: result.edition.blankBytes,
        checksum: result.edition.blankChecksum,
      },
    );

    sendSuccess(res, result, "Blank uploaded");
  }, "platform.uploadFormBlank");

  /** What importing this edition's blank would change. Writes nothing. */
  previewFormImport = asyncWrap(async (req: Request, res: Response) => {
    const plan = await previewImport(
      String(req.params.formCode),
      String(req.params.editionId),
    );
    sendSuccess(res, plan);
  }, "platform.previewFormImport");

  /** Write the catalogue from the edition's blank. The confirmed step. */
  importFormCatalogue = asyncWrap(async (req: Request, res: Response) => {
    const formCode = String(req.params.formCode);
    const editionId = String(req.params.editionId);
    const result = await importCatalogue(formCode, editionId);

    await audit(
      "platform.form_catalogue_imported",
      editionId,
      `${formCode} ${result.editionDate}: ${result.fields} fields catalogued, ${result.carriedForward.length} data carried forward`,
      {
        formCode,
        editionDate: result.editionDate,
        fields: result.fields,
        added: result.added.length,
        changed: result.changed.length,
        carriedForward: result.carriedForward.length,
      },
    );

    sendSuccess(res, result, "Catalogue imported");
  }, "platform.importFormCatalogue");
}
