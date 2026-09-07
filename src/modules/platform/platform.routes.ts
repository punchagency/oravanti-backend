import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
import { formBlankUpload } from "../../middleware/upload";
import { requirePlatformAdmin } from "../../middleware/require-platform-admin";
import { validateRequest } from "../../middleware/validate.middleware";
import { PlatformController } from "./platform.controller";
import {
  addFieldBody,
  addEditionBody,
  addFormBody,
  caseTypeFormParams,
  caseTypeIdParams,
  caseTypeQuery,
  formPartAndCaseTypeQuery,
  formPartQuery,
  createCaseTypeBody,
  createPracticeAreaBody,
  createSubcategoryBody,
  definitionIdParams,
  editionParams,
  formCatalogueQuery,
  formCodeParams,
  formDefinitionParams,
  mappingIdParams,
  pageQuery,
  pdfMappingBody,
  practiceAreaIdParams,
  reorderCaseTypeFormsBody,
  partLabelQuery,
  renamePartBody,
  savePartBody,
  reorderFieldsBody,
  setCaseTypeFormBody,
  setFieldMappingBody,
  setFieldMappingsBody,
  subcategoryIdParams,
  updateCaseTypeBody,
  updateFieldBody,
  updateEditionBody,
  updateFormBody,
  updateTaxonomyNodeBody,
} from "./platform.validation";

/**
 * The Oravanti CRM's API.
 *
 * Everything here operates the *platform's* content — the form catalogue, the
 * field vocabulary, the PDF box mappings — rather than any firm's matters.
 * That is the whole boundary: a route belongs on this router when the thing it
 * changes is identical for every firm in the deployment, and on `/cases` when
 * it is one firm's own.
 *
 * ─── One gate, mounted once ─────────────────────────────────────────────────
 *
 * `requireAuth` then `requirePlatformAdmin`, at the top, for the whole router.
 * Per-route guards are how five mutating `/cases` endpoints once shipped
 * ungated beside gated reads; mounting at the router means a route added later
 * inherits the gate rather than needing somebody to remember it.
 *
 * Note the absence of `resolveActorContext`, which every other authenticated
 * router uses. A platform admin has no organization to resolve, and
 * `requireAuth` deliberately opens no tenant connection for one — which is
 * what leaves `db` pointed at `systemDb`, the only connection that can write
 * the `organization_id IS NULL` rows this router exists to maintain.
 *
 * ─── Addressed by form, not by matter ───────────────────────────────────────
 *
 * Every route below took a `caseId` in its previous life under `/cases`, and
 * none of them used it to scope the write — it was an access check borrowed
 * from a neighbouring route, and it made a global change look like a local
 * one. `PUT /cases/:caseId/forms/:formCode/pdf-mappings` was reachable with
 * `cases:update` and rewrote which box a datum prints into *for every firm in
 * the deployment*. That is why these moved.
 */
export class PlatformRouter {
  public router: Router;
  public path: string;
  private controller: PlatformController;

  constructor(controller: PlatformController) {
    this.router = Router();
    this.path = "/platform";
    this.controller = controller;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(requirePlatformAdmin);

    const c = this.controller;

    /**
     * @openapi
     * /platform/me:
     *   get:
     *     tags: [Platform]
     *     summary: The signed-in platform operator
     *     responses:
     *       200: { description: The operator's own record }
     *       403: { description: Not a platform admin }
     */
    this.router.get("/me", c.getMe);

    // ─── The taxonomy: practice area → subcategory → case type ─────────────
    //
    // Three levels, walked one page at a time. 8 areas, 57 subcategories, 687
    // case types — the last number is why the middle level is shown rather
    // than flattened, and why nothing here returns a whole list.

    /**
     * @openapi
     * /platform/taxonomy/counts:
     *   get:
     *     tags: [Platform]
     *     summary: How big the taxonomy is, and how much of it files anything
     */
    this.router.get("/taxonomy/counts", c.taxonomyCounts);

    /**
     * @openapi
     * /platform/practice-areas:
     *   get:
     *     tags: [Platform]
     *     summary: The practice areas, with the size of what is under each
     */
    this.router.get(
      "/practice-areas",
      validateRequest({ query: pageQuery }),
      c.listPracticeAreas,
    );

    /**
     * @openapi
     * /platform/practice-areas/{practiceAreaId}:
     *   get:
     *     tags: [Platform]
     *     summary: One practice area, with what it says about itself
     *   patch:
     *     tags: [Platform]
     *     summary: Rename it, describe it, or archive it
     *   delete:
     *     tags: [Platform]
     *     summary: Delete an empty practice area
     *     description: >
     *       Refused with the list of what is in the way if anything references
     *       it, however indirectly. Archiving is the operation for a practice
     *       area with history; this is for a mistake made ten minutes ago.
     *     responses:
     *       409: { description: In use — the body lists what holds it }
     */
    this.router.get(
      "/practice-areas/:practiceAreaId",
      validateRequest({ params: practiceAreaIdParams }),
      c.getPracticeArea,
    );
    this.router.patch(
      "/practice-areas/:practiceAreaId",
      validateRequest({
        params: practiceAreaIdParams,
        body: updateTaxonomyNodeBody,
      }),
      c.updatePracticeArea,
    );
    this.router.delete(
      "/practice-areas/:practiceAreaId",
      validateRequest({ params: practiceAreaIdParams }),
      c.deletePracticeArea,
    );

    /**
     * @openapi
     * /platform/practice-areas:
     *   post:
     *     tags: [Platform]
     *     summary: Add a practice area
     *     responses:
     *       409: { description: A practice area with that name already exists }
     */
    this.router.post(
      "/practice-areas",
      validateRequest({ body: createPracticeAreaBody }),
      c.createPracticeArea,
    );

    /**
     * @openapi
     * /platform/practice-areas/{practiceAreaId}/subcategories:
     *   get:
     *     tags: [Platform]
     *     summary: One practice area's subcategories
     */
    this.router.get(
      "/practice-areas/:practiceAreaId/subcategories",
      validateRequest({ params: practiceAreaIdParams, query: pageQuery }),
      c.listSubcategories,
    );
    this.router.post(
      "/practice-areas/:practiceAreaId/subcategories",
      validateRequest({
        params: practiceAreaIdParams,
        body: createSubcategoryBody,
      }),
      c.createSubcategory,
    );

    /**
     * @openapi
     * /platform/subcategories/{subcategoryId}:
     *   get:
     *     tags: [Platform]
     *     summary: One subcategory, and how many case types sit under it
     *   patch:
     *     tags: [Platform]
     *     summary: Rename it, describe it, or archive it
     *   delete:
     *     tags: [Platform]
     *     summary: Delete an empty subcategory
     *     responses:
     *       409: { description: It still holds case types }
     */
    this.router.get(
      "/subcategories/:subcategoryId",
      validateRequest({ params: subcategoryIdParams }),
      c.getSubcategory,
    );
    this.router.patch(
      "/subcategories/:subcategoryId",
      validateRequest({
        params: subcategoryIdParams,
        body: updateTaxonomyNodeBody,
      }),
      c.updateSubcategory,
    );
    this.router.delete(
      "/subcategories/:subcategoryId",
      validateRequest({ params: subcategoryIdParams }),
      c.deleteSubcategory,
    );

    /**
     * @openapi
     * /platform/subcategories/{subcategoryId}/case-types:
     *   get:
     *     tags: [Platform]
     *     summary: One subcategory's case types, each saying whether it is set up
     */
    this.router.get(
      "/subcategories/:subcategoryId/case-types",
      validateRequest({ params: subcategoryIdParams, query: pageQuery }),
      c.listCaseTypes,
    );
    this.router.post(
      "/subcategories/:subcategoryId/case-types",
      validateRequest({ params: subcategoryIdParams, body: createCaseTypeBody }),
      c.createCaseType,
    );

    /**
     * @openapi
     * /platform/case-types/{caseTypeId}:
     *   patch:
     *     tags: [Platform]
     *     summary: Rename it, describe it, restate its jurisdiction, or archive it
     *     description: >
     *       `caseNumberPrefix` is editable but retroactively meaningless — it is
     *       stamped into matter numbers when they are issued, so a change here
     *       decides what the next matter is called and nothing else.
     *   delete:
     *     tags: [Platform]
     *     summary: Delete a case type nothing has touched
     *     responses:
     *       409: { description: In use — the body lists what holds it }
     */
    this.router.patch(
      "/case-types/:caseTypeId",
      validateRequest({ params: caseTypeIdParams, body: updateCaseTypeBody }),
      c.updateCaseType,
    );
    this.router.delete(
      "/case-types/:caseTypeId",
      validateRequest({ params: caseTypeIdParams }),
      c.deleteCaseType,
    );

    // ─── One case type's filing package ────────────────────────────────────
    //
    // These decide what every firm's *next* matter of this type is provisioned
    // with. `defaultPackageFor` reads exactly these rows, so a change here is
    // a change to what gets filed — which is precisely why it sits behind
    // `requirePlatformAdmin` and not on the firm's router.

    /**
     * @openapi
     * /platform/case-types/{caseTypeId}:
     *   get:
     *     tags: [Platform]
     *     summary: Where a case type sits, what it files, and what it asks
     */
    this.router.get(
      "/case-types/:caseTypeId",
      validateRequest({ params: caseTypeIdParams }),
      c.getCaseType,
    );

    /**
     * @openapi
     * /platform/case-types/{caseTypeId}/available-forms:
     *   get:
     *     tags: [Platform]
     *     summary: The catalogue minus what is already on this package
     */
    this.router.get(
      "/case-types/:caseTypeId/available-forms",
      validateRequest({ params: caseTypeIdParams, query: pageQuery }),
      c.listFormsForCaseType,
    );

    /**
     * @openapi
     * /platform/case-types/{caseTypeId}/forms:
     *   post:
     *     tags: [Platform]
     *     summary: Put a catalogued form on this case type's package
     *     responses:
     *       404: { description: No such case type, or no such form in the catalogue }
     *   put:
     *     tags: [Platform]
     *     summary: Set the filing order
     *     description: >
     *       Takes the whole package. A partial list would have to decide what
     *       happens to the forms it did not mention, and every answer to that
     *       is a rule somebody has to remember.
     */
    this.router.post(
      "/case-types/:caseTypeId/forms",
      validateRequest({ params: caseTypeIdParams, body: setCaseTypeFormBody }),
      c.setCaseTypeForm,
    );
    this.router.put(
      "/case-types/:caseTypeId/forms",
      validateRequest({ params: caseTypeIdParams, body: reorderCaseTypeFormsBody }),
      c.reorderCaseTypeForms,
    );

    /**
     * @openapi
     * /platform/case-types/{caseTypeId}/forms/{formCode}:
     *   delete:
     *     tags: [Platform]
     *     summary: Take a form off this case type's package
     *     description: >
     *       Matters already open keep the form. This decides what the next one
     *       starts with.
     */
    this.router.delete(
      "/case-types/:caseTypeId/forms/:formCode",
      validateRequest({ params: caseTypeFormParams }),
      c.removeCaseTypeForm,
    );

    // ─── The form catalogue ────────────────────────────────────────────────

    /**
     * @openapi
     * /platform/forms:
     *   get:
     *     tags: [Platform]
     *     summary: Every form Oravanti publishes
     *     description: >
     *       Paged and searchable, and narrowable to one practice area with
     *       ?practiceAreaId — a form belongs to a practice area only through
     *       the case-type packages that file it, so the facet is derived from
     *       case_type_forms rather than read off the form.
     *   post:
     *     tags: [Platform]
     *     summary: Name a new form
     *     description: >
     *       The catalogue entry only. Which matters file it is decided by the
     *       workflow template and by firms adding it to a matter — naming a
     *       form does not put it on anybody's case.
     *     responses:
     *       201: { description: Added }
     *       400: { description: That code is already catalogued }
     */
    this.router.get(
      "/forms",
      validateRequest({ query: formCatalogueQuery }),
      c.listForms,
    );
    this.router.post(
      "/forms",
      validateRequest({ body: addFormBody }),
      c.addForm,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}:
     *   get:
     *     tags: [Platform]
     *     summary: One form and its fields
     */
    this.router.get(
      "/forms/:formCode",
      validateRequest({ params: formCodeParams }),
      c.getForm,
    );

    /**
     * @openapi
     * /platform/forms/{definitionId}:
     *   patch:
     *     tags: [Platform]
     *     summary: Reword a form
     *     description: >
     *       `formCode` is not editable: every value, mapping and filing is
     *       keyed by it, so changing it would not rename a form but orphan one.
     *   delete:
     *     tags: [Platform]
     *     summary: Remove a form from the catalogue
     *     description: >
     *       Takes its fields with it. Nothing on any matter is touched — a form
     *       already filed stays filed, and what somebody typed into it is part
     *       of the record of that matter.
     */
    this.router.patch(
      "/forms/definitions/:definitionId",
      validateRequest({ params: definitionIdParams, body: updateFormBody }),
      c.updateForm,
    );
    this.router.delete(
      "/forms/definitions/:definitionId",
      validateRequest({ params: definitionIdParams }),
      c.deleteForm,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/fields:
     *   get:
     *     tags: [Platform]
     *     summary: The form's fields in printing order, all or one part
     *     description: >
     *       `?part=` narrows the read to one part — the form's own division,
     *       by label. An empty `?part=` is the part of a form whose fields
     *       carry no label at all; omitting it altogether is the whole form.
     *   post:
     *     tags: [Platform]
     *     summary: Add a field
     *     description: >
     *       Giving the field the `fieldKey` an existing question already uses
     *       is what makes it fill automatically, with no mapping at all.
     */
    this.router.get(
      "/forms/:formCode/fields",
      validateRequest({ params: formCodeParams, query: formPartQuery }),
      c.listFields,
    );
    this.router.post(
      "/forms/:formCode/fields",
      validateRequest({ params: formCodeParams, body: addFieldBody }),
      c.addField,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/part:
     *   patch:
     *     tags: [Platform]
     *     summary: Rename one part of a form
     *     description: >
     *       A part is not a row — it is the distinct `part_label` values on the
     *       form's fields — so this updates every field in the part at once.
     *       `from` may be null, meaning the fields the extraction could not
     *       place; `to` may not, because un-naming a part puts its fields back
     *       on that pile. Renaming onto a part the form already has is refused
     *       rather than merged.
     *     responses:
     *       200: { description: The new name and how many fields moved }
     *       400: { description: That name is taken, or is already this part's }
     *       404: { description: No such part on this form }
     */
    this.router.patch(
      "/forms/:formCode/part",
      validateRequest({ params: formCodeParams, body: renamePartBody }),
      c.renamePart,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/parts:
     *   put:
     *     tags: [Platform]
     *     summary: Name a part, or describe one
     *     description: >
     *       One write for both. `form_parts` carries a part's description and,
     *       by existing, a part that has no fields in it yet — which is how an
     *       operator names a part before adding the first field to it. A part
     *       the fields already produce gains its description here.
     *   delete:
     *     tags: [Platform]
     *     summary: Remove an empty part
     *     description: >
     *       Only an empty one. A part with fields is emptied first, a field at
     *       a time — one control that takes 172 field definitions off a
     *       government form is not a control this catalogue offers.
     *     responses:
     *       400: { description: The part still has fields in it }
     *       404: { description: No such part on this form }
     */
    this.router.put(
      "/forms/:formCode/parts",
      validateRequest({ params: formCodeParams, body: savePartBody }),
      c.savePart,
    );
    this.router.delete(
      "/forms/:formCode/parts",
      validateRequest({ params: formCodeParams, query: partLabelQuery }),
      c.removePart,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/fields/order:
     *   put:
     *     tags: [Platform]
     *     summary: Save the whole form's field order at once
     */
    this.router.put(
      "/forms/:formCode/fields/order",
      validateRequest({ params: formCodeParams, body: reorderFieldsBody }),
      c.reorderFields,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/fields/{definitionId}:
     *   patch:
     *     tags: [Platform]
     *     summary: Reword a field
     *     description: >
     *       `fieldKey` is not editable: it is the shared vocabulary connecting
     *       this field to the question that fills it, and changing it would
     *       silently unfill the field rather than rename it.
     *   delete:
     *     tags: [Platform]
     *     summary: Remove a field
     *     description: >
     *       The value already on any matter's form is left alone. A field
     *       dropped from the catalogue stops printing; what somebody typed into
     *       it stays in that matter's history.
     */
    this.router.patch(
      "/forms/:formCode/fields/:definitionId",
      validateRequest({ params: formDefinitionParams, body: updateFieldBody }),
      c.updateField,
    );
    this.router.delete(
      "/forms/:formCode/fields/:definitionId",
      validateRequest({ params: formDefinitionParams }),
      c.deleteField,
    );

    // ─── Field sources ─────────────────────────────────────────────────────

    /**
     * @openapi
     * /platform/forms/{formCode}/field-map:
     *   get:
     *     tags: [Platform]
     *     summary: What fills each field of one part
     *     description: >
     *       Every field of the part, not only the mapped ones — "what fills
     *       this box?" is a question about all of them. The questions a field
     *       may be pointed at come from `/source-questions` rather than here,
     *       because they are the same list whichever part is open.
     *   put:
     *     tags: [Platform]
     *     summary: Save the whole form's field sources at once
     *     description: >
     *       A null `sourceQuestionId` clears that field's mapping, returning it
     *       to whatever the shared `fieldKey` vocabulary says.
     */
    this.router.get(
      "/forms/:formCode/field-map",
      validateRequest({
        params: formCodeParams,
        query: formPartAndCaseTypeQuery,
      }),
      c.getFieldMap,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/source-questions:
     *   get:
     *     tags: [Platform]
     *     summary: The questions a field on this form can be pointed at
     *     description: >
     *       `caseTypeId` narrows them to one case type's questionnaire. Omit it
     *       and every case-stage question is offered, which is the right
     *       default for a form filed under more than one case type — the
     *       `fieldKey` vocabulary is global, so a question is not confined to
     *       the questionnaire it sits in.
     */
    this.router.get(
      "/forms/:formCode/source-questions",
      validateRequest({ params: formCodeParams, query: caseTypeQuery }),
      c.getSourceQuestions,
    );
    this.router.put(
      "/forms/:formCode/field-map",
      validateRequest({ params: formCodeParams, body: setFieldMappingsBody }),
      c.setFieldMappings,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/field-map/one:
     *   put:
     *     tags: [Platform]
     *     summary: Point one field at a question
     *     description: >
     *       Displacing a question the shared vocabulary already points at
     *       requires a rationale, which is stored with the mapping.
     *     responses:
     *       400: { description: Displaces a shared key without a rationale }
     */
    this.router.put(
      "/forms/:formCode/field-map/one",
      validateRequest({ params: formCodeParams, body: setFieldMappingBody }),
      c.setFieldMapping,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/field-map/{mappingId}:
     *   delete:
     *     tags: [Platform]
     *     summary: Remove a mapping
     *     description: >
     *       Returns the field to whatever the shared vocabulary says. Values
     *       already on any matter's form are left alone — a mapping decides
     *       where future answers come from, not what a form currently reads.
     */
    this.router.delete(
      "/forms/:formCode/field-map/:mappingId",
      validateRequest({ params: mappingIdParams }),
      c.clearFieldMapping,
    );

    // ─── PDF boxes ─────────────────────────────────────────────────────────

    /**
     * @openapi
     * /platform/forms/{formCode}/pdf-boxes:
     *   get:
     *     tags: [Platform]
     *     summary: Every fillable box on the form's official blank
     *     description: >
     *       Read out of the PDF itself, so it cannot drift from the file it
     *       describes. Barcode fields are excluded.
     */
    this.router.get(
      "/forms/:formCode/pdf-boxes",
      validateRequest({ params: formCodeParams }),
      c.getPdfBoxes,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/pdf-preview:
     *   get:
     *     tags: [Platform]
     *     summary: The form's official blank
     *     description: >
     *       The blank as the government prints it, with nothing written into
     *       it — the one view of the real paper. How much of it is wired up
     *       rides in the `X-Boxes*` headers; which datum claims which box is
     *       the PDF boxes screen.
     *     responses:
     *       200:
     *         content:
     *           application/pdf: {}
     */
    this.router.get(
      "/forms/:formCode/pdf-preview",
      validateRequest({ params: formCodeParams }),
      c.getFormPdfPreview,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/pdf-mappings:
     *   get:
     *     tags: [Platform]
     *     summary: Which datum prints into which box
     *   put:
     *     tags: [Platform]
     *     summary: Point a field key at a box, or clear it
     *     description: >
     *       A null `pdfFieldName` clears the mapping. Pointing a second field
     *       key at an already-mapped box reclaims it, since a box holds one
     *       datum. A choice is mapped one option at a time: send `fieldValue`
     *       to say which answer marks the box, since USCIS prints a checkbox
     *       per option rather than one box holding the answer.
     */
    this.router.get(
      "/forms/:formCode/pdf-mappings",
      validateRequest({ params: formCodeParams, query: formPartQuery }),
      c.getPdfMappings,
    );
    this.router.put(
      "/forms/:formCode/pdf-mappings",
      validateRequest({ params: formCodeParams, body: pdfMappingBody }),
      c.setPdfMapping,
    );

    // ─── Editions, and the blank each one is filed on ──────────────────────

    /**
     * @openapi
     * /platform/forms/{formCode}/editions:
     *   get:
     *     tags: [Platform]
     *     summary: Every edition of a form, and whether it has a blank
     *   post:
     *     tags: [Platform]
     *     summary: Record a new edition
     *     description: >
     *       The edition and its acceptance window only — the blank is uploaded
     *       separately, because the two are separate facts. USCIS announces an
     *       edition months before anybody downloads the PDF, and an edition
     *       with no blank is a legitimate state rather than a broken one.
     *     responses:
     *       201: { description: Recorded }
     *       400: { description: That edition is already on record }
     */
    this.router.get(
      "/forms/:formCode/editions",
      validateRequest({ params: formCodeParams }),
      c.listFormEditions,
    );
    this.router.post(
      "/forms/:formCode/editions",
      validateRequest({ params: formCodeParams, body: addEditionBody }),
      c.addFormEdition,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/editions/{editionId}:
     *   patch:
     *     tags: [Platform]
     *     summary: Correct an edition's acceptance window or source
     *     description: >
     *       `editionDate` is not editable: it is half the natural key and every
     *       box mapping on the blank hangs off this row, so changing it would
     *       not rename an edition but mislabel one.
     */
    this.router.patch(
      "/forms/:formCode/editions/:editionId",
      validateRequest({ params: editionParams, body: updateEditionBody }),
      c.updateFormEdition,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/editions/{editionId}/blank:
     *   post:
     *     tags: [Platform]
     *     summary: Upload the official blank for an edition
     *     description: >
     *       Multipart, one `blank` file, PDF only. Stores the file, records its
     *       checksum, reads the boxes off it and keeps the extraction beside
     *       it. It changes **nothing** about the catalogue — the response is a
     *       plan describing what an import would do, and
     *       `POST .../catalogue` is what acts on it.
     *
     *       Re-uploading a byte-identical file is a no-op, reported as one.
     *       A PDF with no fillable boxes is refused with the reason: USCIS
     *       publishes a flat print-only edition alongside the fillable one and
     *       it is easy to download the wrong one.
     *     responses:
     *       200: { description: Stored, with the import plan }
     *       400: { description: Not a fillable PDF }
     *       413: { description: Over the size limit }
     */
    this.router.post(
      "/forms/:formCode/editions/:editionId/blank",
      formBlankUpload().single("blank"),
      validateRequest({ params: editionParams }),
      c.uploadFormBlank,
    );

    /**
     * @openapi
     * /platform/forms/{formCode}/editions/{editionId}/import:
     *   get:
     *     tags: [Platform]
     *     summary: What importing this blank would change
     *     description: >
     *       Writes nothing. This is the review the committed extraction used to
     *       get from a pull request diff — the rows behind it decide what
     *       prints on a statutory form for every firm in the deployment.
     *   post:
     *     tags: [Platform]
     *     summary: Write the catalogue from this edition's blank
     *     description: >
     *       Idempotent. A box an existing mapping already speaks for is left
     *       alone, and a curated datum on the previous edition of the same form
     *       is carried onto any box that kept its name.
     */
    this.router.get(
      "/forms/:formCode/editions/:editionId/import",
      validateRequest({ params: editionParams }),
      c.previewFormImport,
    );
    this.router.post(
      "/forms/:formCode/editions/:editionId/import",
      validateRequest({ params: editionParams }),
      c.importFormCatalogue,
    );
  }
}
