import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { caseForms } from "../../db/schema/case-forms";
import { cases } from "../../db/schema/cases";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { AOS_PACKAGE_FORMS } from "../uscis-reference/form-edition.service";
import { quoteFees } from "../uscis-reference/filing-fee.service";
import { checkCase } from "./aos-validation.service";
import { requireAdjustmentPackage } from "./case-capabilities.service";
import { sendSuccess } from "../../utils/send-success";
import { getTaskReviewEvents } from "../shared/task-review-events.service";
import { WorkflowService } from "./workflow.service";
import { linkCase, unlinkCase } from "./case-link.service";
import {
  listCaseMilestones,
  recordCaseMilestone,
} from "./case-milestone.service";
import {
  addCaseForm,
  ensurePackageForms,
  listCaseForms,
  packageProgress,
  removeCaseForm,
  updateCaseForm,
} from "./case-forms.service";
import { listCatalogueForms } from "./form-catalogue.service";
import {
  approveFiling,
  commentOnCorrection,
  getFilingReview,
  raiseCorrection,
  reopenCorrection,
  requestReview,
  resolveCorrection,
} from "./form-review.service";
import { getFeedsForForms } from "./form-mappings.service";
import {
  getFormVersion,
  listFieldRevisions,
  listFormVersions,
  restoreFieldRevision,
  restoreFormVersion,
} from "./form-history.service";
import {
  populateCaseForms,
  readCaseForm,
  setCaseFormField,
  setCaseFormFields,
} from "./form-population.service";

import { formPdfService } from "./form-pdf.service";
import { computeMandamusCandidacy } from "./mandamus.service";
import {
  getImmigrationDetails,
  getPersonalInjuryDetails,
  upsertImmigrationDetails,
  upsertPersonalInjuryDetails,
} from "./case-details.service";

export class WorkflowController {
  private workflowService: WorkflowService;

  constructor(workflowService: WorkflowService) {
    this.workflowService = workflowService;
  }

  getWorkflow = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const result = await this.workflowService.getWorkflow(
      caseId,
      organizationId!,
    );
    sendSuccess(res, result, "Workflow retrieved successfully");
  });

  getWorkflowSummary = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const result = await this.workflowService.getWorkflowSummary(
      caseId,
      organizationId!,
    );
    sendSuccess(res, result, "Workflow summary retrieved successfully");
  });

  completeStep = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { notes } = req.body;
    const result = await this.workflowService.completeStep(
      caseId,
      stepId,
      organizationId!,
      staffId ?? undefined,
      notes,
    );
    sendSuccess(res, result, "Step completed successfully");
  });

  submitForReview = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { notes } = req.body;
    const result = await this.workflowService.submitForReview(
      caseId,
      stepId,
      organizationId!,
      staffId ?? undefined,
      notes,
    );
    sendSuccess(res, result, "Step submitted for review successfully");
  });

  approveStep = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { notes } = req.body;
    const result = await this.workflowService.approveStep(
      caseId,
      stepId,
      organizationId!,
      staffId ?? undefined,
      notes,
    );
    sendSuccess(res, result, "Step approved successfully");
  });

  rejectStep = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { feedback } = req.body;
    const result = await this.workflowService.rejectStep(
      caseId,
      stepId,
      organizationId!,
      staffId ?? undefined,
      feedback,
    );
    sendSuccess(res, result, "Step rejected");
  });

  reopenStep = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { notes } = req.body;
    const result = await this.workflowService.reopenStep(
      caseId,
      stepId,
      organizationId!,
      staffId ?? undefined,
      notes,
    );
    sendSuccess(res, result, "Step reopened");
  });

  /** The step's full submit/approve/reject/reopen note thread. */
  getStepReviewThread = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const stepId = req.params.stepId as string;
    const events = await getTaskReviewEvents(
      "case_step",
      stepId,
      organizationId!,
    );
    sendSuccess(res, events, "Step review thread retrieved");
  });

  assignStep = asyncWrap(async (req: Request, res: Response) => {
    const { staffId: _actorStaffId, organizationId } = getRequestContext();
    const actorStaffId = _actorStaffId ?? undefined;
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { staffId: assigneeStaffId, overrideRationale } = req.body;
    if (!assigneeStaffId) throw new BadRequestError("staffId is required");

    const result = await this.workflowService.assignStep(
      caseId,
      stepId,
      assigneeStaffId,
      organizationId!,
      overrideRationale,
      actorStaffId,
    );
    sendSuccess(res, result, "Step assigned successfully");
  });

  activateModule = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const moduleId = req.params.moduleId as string;
    const result = await this.workflowService.activateModule(
      caseId,
      moduleId,
      organizationId!,
    );
    sendSuccess(res, result, "Module activated successfully");
  });

  getTimeline = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const result = await this.workflowService.getTimeline(
      caseId,
      organizationId!,
    );
    sendSuccess(res, result, "Timeline retrieved successfully");
  });

  getLogs = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const result = await this.workflowService.getLogs(caseId, organizationId!);
    sendSuccess(res, result, "Logs retrieved successfully");
  });

  // Case Notes

  createNote = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const {
      workflowModuleId,
      taskId,
      category,
      visibility,
      isPinned,
      context,
      content,
    } = req.body;
    if (!content) throw new BadRequestError("content is required");

    const result = await this.workflowService.createNote({
      caseId,
      organizationId: organizationId!,
      workflowModuleId,
      taskId,
      category,
      visibility,
      isPinned,
      context,
      content,
      createdByUserId: staffId!,
    });
    sendSuccess(res, result, "Note created successfully", 201);
  });

  getNotes = asyncWrap(async (req: Request, res: Response) => {
    const { staffId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const { pinnedOnly, authorId, context, page, limit } = req.query;

    // Look up user role from staff table
    const userRole = staffId ? "admin" : "staff";

    const result = await this.workflowService.getNotes({
      caseId,
      userRole,
      userId: staffId!,
      pinnedOnly: pinnedOnly === "true" ? true : undefined,
      authorId: authorId as string | undefined,
      context: context as string | undefined,
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });
    sendSuccess(res, result.data, "Notes retrieved successfully", 200, {
      pagination: result.pagination,
    });
  });

  updateNote = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const noteId = req.params.noteId as string;
    const { content, category, visibility, isPinned } = req.body;
    const result = await this.workflowService.updateNote(
      noteId,
      caseId,
      {
        content,
        category,
        visibility,
        isPinned,
      },
      staffId ?? undefined,
      organizationId ?? undefined,
    );
    sendSuccess(res, result, "Note updated successfully");
  });

  deleteNote = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const noteId = req.params.noteId as string;
    await this.workflowService.deleteNote(
      noteId,
      caseId,
      staffId ?? undefined,
      organizationId ?? undefined,
    );
    sendSuccess(res, null, "Note deleted successfully");
  });

  toggleNotePin = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const noteId = req.params.noteId as string;
    const actorId = staffId ?? undefined;
    const result = await this.workflowService.toggleNotePin(
      noteId,
      caseId,
      organizationId ?? undefined,
      actorId ?? undefined,
    );
    sendSuccess(res, result, "Note pin toggled successfully");
  });

  bulkDeleteNotes = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const { noteIds } = req.body;
    if (!noteIds || !Array.isArray(noteIds)) {
      throw new BadRequestError("noteIds array is required");
    }
    const actorId = staffId ?? undefined;
    await this.workflowService.bulkDeleteNotes(
      noteIds,
      caseId,
      organizationId ?? undefined,
      actorId ?? undefined,
    );
    sendSuccess(res, null, "Notes deleted successfully");
  });

  bulkPinNotes = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const { noteIds, pinned } = req.body;
    if (!noteIds || !Array.isArray(noteIds)) {
      throw new BadRequestError("noteIds array is required");
    }
    if (typeof pinned !== "boolean") {
      throw new BadRequestError("pinned boolean is required");
    }
    const actorId = staffId ?? undefined;
    await this.workflowService.bulkPinNotes(
      noteIds,
      caseId,
      pinned,
      organizationId ?? undefined,
      actorId ?? undefined,
    );
    sendSuccess(res, null, "Notes pinned successfully");
  });

  /**
   * Days pending against USCIS's published median for this form and office.
   *
   * A number for an attorney to read, never a button that files anything —
   * opening the mandamus matter is a separate, deliberate action (`linkCase`).
   */
  getMandamusCandidacy = asyncWrap(async (req: Request, res: Response) => {
    const candidacy = await computeMandamusCandidacy(String(req.params.caseId));
    sendSuccess(res, candidacy, "Mandamus candidacy computed successfully");
  });

  linkCase = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const { childCaseId, relationType } = req.body;

    const updated = await linkCase({
      parentCaseId: String(req.params.caseId),
      childCaseId,
      relationType,
      organizationId: organizationId!,
      actorStaffId: staffId ?? null,
    });

    sendSuccess(res, updated, "Case linked successfully", 201);
  });

  unlinkCase = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();

    const updated = await unlinkCase({
      childCaseId: String(req.params.caseId),
      organizationId: organizationId!,
      actorStaffId: staffId ?? null,
    });

    sendSuccess(res, updated, "Case unlinked successfully");
  });

  /*
    The two practice-area extension tables.

    `null` rather than 404 when no row exists: a case whose panel nobody has
    filled in yet is the normal starting state, and the form needs to render
    empty rather than handle an error. Writing goes through the service's
    upsert, which is also where the condition/anchor/RFE hooks fire — see
    case-details.service.ts.
  */

  getImmigrationDetails = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const details = await getImmigrationDetails(
      String(req.params.caseId),
      organizationId!,
    );
    sendSuccess(
      res,
      details,
      "Immigration case details retrieved successfully",
    );
  });

  upsertImmigrationDetails = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();

    const saved = await upsertImmigrationDetails({
      caseId: String(req.params.caseId),
      organizationId: organizationId!,
      patch: req.body,
      actorStaffId: staffId ?? null,
    });

    sendSuccess(res, saved, "Immigration case details saved successfully");
  });

  /**
   * Recording what the agency did — a receipt notice, an appointment, a
   * decision.
   *
   * Separate from the immigration-details patch because it is not a field
   * write: it also writes the chronology row, the calendar event and the audit
   * entry, then re-resolves every task anchored on that date.
   */
  recordCaseMilestone = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();

    const saved = await recordCaseMilestone({
      caseId: String(req.params.caseId),
      organizationId: organizationId!,
      milestone: req.body.milestone,
      occurredOn: req.body.occurredOn,
      noticeNumber: req.body.noticeNumber ?? null,
      note: req.body.note ?? null,
      actorStaffId: staffId ?? null,
    });

    sendSuccess(res, saved, "Milestone recorded successfully", 201);
  });

  listCaseMilestones = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const milestones = await listCaseMilestones(
      String(req.params.caseId),
      organizationId!,
    );
    sendSuccess(res, milestones, "Case milestones retrieved successfully");
  });

  /**
   * The § 1.5 pitfalls for one matter.
   *
   * Read-only and computed on demand rather than stored: every rule reads fields
   * that change, and a stored warning would go stale the moment one did. This is
   * cheap — two reference lookups and six pure functions.
   */
  /**
   * The matter's filing package, one entry per form.
   *
   * Returned with a progress rollup so the UI does not re-derive it — and so
   * "how far along is the package?" has one answer rather than one per caller.
   */
  listCaseForms = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = String(req.params.caseId);

    const [forms, progress] = await Promise.all([
      listCaseForms(caseId, organizationId!),
      packageProgress(caseId, organizationId!),
    ]);

    sendSuccess(res, { forms, progress }, "Case forms retrieved successfully");
  });

  /** Creates the package's rows. Additive — an existing form keeps its state. */
  initializeCaseForms = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const created = await ensurePackageForms({
      caseId: String(req.params.caseId),
      organizationId: organizationId!,
      forms: req.body?.forms,
    });

    sendSuccess(res, { created }, "Filing package set up successfully", 201);
  });

  updateCaseForm = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const updated = await updateCaseForm({
      caseId: String(req.params.caseId),
      formCode: String(req.params.formCode),
      organizationId: organizationId!,
      patch: req.body,
    });

    sendSuccess(res, updated, "Form updated successfully");
  });

  removeCaseForm = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    await removeCaseForm({
      caseId: String(req.params.caseId),
      formCode: String(req.params.formCode),
      organizationId: organizationId!,
    });

    sendSuccess(res, null, "Form removed successfully");
  });

  /** One form's contents — the catalogue, each field's value, and its provenance. */
  readCaseFormFields = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const result = await readCaseForm({
      caseId: String(req.params.caseId),
      formCode: String(req.params.formCode),
      organizationId: organizationId!,
    });

    sendSuccess(res, result, "Form fields retrieved successfully");
  });

  setCaseFormField = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();

    const saved = await setCaseFormField({
      caseId: String(req.params.caseId),
      formCode: String(req.params.formCode),
      fieldKey: String(req.params.fieldKey),
      value: req.body.value,
      organizationId: organizationId!,
      updatedById: staffId ?? undefined,
    });

    sendSuccess(res, saved, "Field saved successfully");
  });

  setCaseFormFields = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();

    const { changed, version } = await setCaseFormFields({
      caseId: String(req.params.caseId),
      formCode: String(req.params.formCode),
      fields: req.body.fields,
      organizationId: organizationId!,
      updatedById: staffId ?? undefined,
    });

    sendSuccess(
      res,
      { changed, version },
      changed === 0
        ? "No changes to save"
        : `${changed} field${changed === 1 ? "" : "s"} saved`,
    );
  });

  populateCaseForms = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();

    const result = await populateCaseForms({
      caseId: String(req.params.caseId),
      organizationId: organizationId!,
      updatedById: staffId ?? undefined,
      overrideManual: req.body?.overrideManual === true,
      dryRun: req.body?.dryRun === true,
    });

    sendSuccess(
      res,
      result,
      req.body?.dryRun === true
        ? "Population preview"
        : "Forms filled from the case questionnaire",
    );
  });

  // ─── The form catalogue ──────────────────────────────────────────────────
  //
  // Only one handler is left here, and it does not touch the catalogue: what a
  // form is, and what fields it has, is Oravanti's — maintained in the CRM
  // (`modules/platform`), read by every firm, written by none. See
  // `db/schema/form-fields.ts`.

  /**
   * What fills each field, across this matter's forms.
   *
   * Read-only. The Questionnaire tab labels each question with the boxes it
   * fills, which is a question about the whole package. The write that used to
   * share this path is gone — see `getFeedsForForms`.
   */
  getCaseFieldFeeds = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const forms = await listCaseForms(
      String(req.params.caseId),
      organizationId!,
    );

    const feeds = await getFeedsForForms(forms.map((form) => form.formCode));
    sendSuccess(res, feeds, "Field sources retrieved successfully");
  });

  /**
   * Every form Oravanti publishes, so a firm can pick one to add.
   *
   * Read-only, and the only catalogue endpoint a firm can reach. It exists
   * because "add a form to this matter" needs something to choose *from*: the
   * firm no longer names forms, so without this the add route could only be
   * driven by somebody who already knew the code by heart.
   *
   * Gated on `cases:read` rather than left open — the catalogue is not secret,
   * but it is a list of what this deployment can file, and there is no reason
   * for it to be reachable without a matter to put a form on.
   */
  listPublishedForms = asyncWrap(async (_req: Request, res: Response) => {
    sendSuccess(
      res,
      await listCatalogueForms(),
      "Forms retrieved successfully",
    );
  });

  /** Puts a form Oravanti publishes onto this matter. Names nothing. */
  addCaseForm = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const created = await addCaseForm({
      caseId: String(req.params.caseId),
      organizationId: organizationId!,
      formCode: String(req.params.formCode),
      role: req.body.role,
    });

    sendSuccess(res, created, `${created.formCode} added to this matter`, 201);
  });

  // ─── Form history ────────────────────────────────────────────────────────
  //
  // Restores are POSTs rather than PUTs because each one *writes a new version*
  // rather than putting the form back to an old state — nothing after the
  // restored version is erased.

  listFormVersions = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const form = await this.requireCaseForm(req);

    const versions = await listFormVersions(organizationId!, form.id);
    sendSuccess(res, versions, "Form history retrieved successfully");
  });

  getFormVersion = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const version = await getFormVersion(
      organizationId!,
      String(req.params.versionId),
    );
    sendSuccess(res, version, "Version retrieved successfully");
  });

  getFieldHistory = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const form = await this.requireCaseForm(req);

    const revisions = await listFieldRevisions(
      organizationId!,
      form.id,
      String(req.params.fieldKey),
    );
    sendSuccess(res, revisions, "Field history retrieved successfully");
  });

  restoreFormVersion = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();

    const result = await restoreFormVersion({
      organizationId: organizationId!,
      versionId: String(req.params.versionId),
      actorId: staffId ?? undefined,
    });

    sendSuccess(
      res,
      result,
      `Restored version ${result.restoredFrom} — ${result.changed} field${result.changed === 1 ? "" : "s"} changed`,
    );
  });

  restoreFieldRevision = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();

    const result = await restoreFieldRevision({
      organizationId: organizationId!,
      revisionId: String(req.params.revisionId),
      actorId: staffId ?? undefined,
    });

    sendSuccess(res, result, "Field restored successfully");
  });

  /**
   * The `case_forms` row a `/:caseId/forms/:formCode/...` route names.
   *
   * The history tables key on the form's own id and the route names it by code
   * — the code is what a person can read in a URL, the id is what the data is
   * stored under. One lookup here rather than passing both down.
   */
  private requireCaseForm = async (req: Request) => {
    const { organizationId } = getRequestContext();

    const [form] = await db
      .select({ id: caseForms.id })
      .from(caseForms)
      .where(
        and(
          eq(caseForms.caseId, String(req.params.caseId)),
          eq(caseForms.formCode, String(req.params.formCode)),
          eq(caseForms.organizationId, organizationId!),
        ),
      )
      .limit(1);

    if (!form) {
      throw new NotFoundError(`${req.params.formCode} is not on this matter`);
    }
    return form;
  };

  // The wiring — which question fills which field, and which box on the blank
  // each field prints into — used to be reachable from here with
  // `cases:update`. Both are global reference data: one row decides what fills
  // that box for *every* firm in the deployment, so a firm staffer editing a
  // matter could silently repoint a box on the I-485 for everybody. They now
  // live in `modules/platform`, behind `requirePlatformAdmin`.

  /**
   * The matter's copy of a form, filled and streamed as a PDF.
   *
   * Sent inline so the browser renders it in place — this is the read view of
   * the Forms tab, not a download. `flatten` is opt-in, for when the copy is
   * the one being filed rather than checked.
   */
  /**
   * Where each of the form's data prints on the page.
   *
   * Read-only reference data about the *catalogue*, not about the matter — the
   * blank's geometry is the same for every firm — so it needs nothing from the
   * matter but the permission to be looking at it. `cases:read` rather than the
   * platform guard for exactly that reason: reading where a box sits is not
   * editing what fills it, which is the distinction the mapping routes moved to
   * `modules/platform` to enforce.
   */
  getCaseFormBoxes = asyncWrap(async (req: Request, res: Response) => {
    const fields = await formPdfService.fieldPlacements(
      String(req.params.formCode),
    );
    sendSuccess(res, { fields });
  }, "workflow.getCaseFormBoxes");

  getCaseFormPdf = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const formCode = String(req.params.formCode);

    const { bytes, written, mapped, skipped, unplaced } =
      await formPdfService.fillForCase(
        organizationId!,
        String(req.params.caseId),
        formCode,
        { flatten: req.query.flatten === "true" },
      );

    // Named so a saved copy is identifiable, and reported in headers so a
    // caller can tell a fully-filled form from a half-filled one without
    // parsing the PDF.
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${formCode}.pdf"`);
    res.setHeader("X-Fields-Written", String(written));
    res.setHeader("X-Fields-Mapped", String(mapped));
    res.setHeader("X-Fields-Skipped", String(skipped.length));
    /*
      Answers that overflowed the form Additional Information part as well.
      Named, not counted: the paralegal has to type a plain sheet for these, and
      "2" does not tell them which two. A response body is not available here —
      the body is the PDF — so it rides in a header the Forms tab reads.
    */
    if (unplaced.length > 0) {
      res.setHeader(
        "X-Fields-Unplaced",
        unplaced
          .map((block) => `${block.source.base}[${block.source.index}]`)
          .join(","),
      );
    }
    res.send(bytes);
  });

  /**
   * The whole filing package as one PDF.
   *
   * The counterpart to `getCaseFormPdf`, and the thing a paralegal actually
   * assembles: a filing goes to USCIS as one ordered package, and clicking six
   * times gets the order wrong and the count wrong.
   *
   * Headers rather than a body, because the body is the PDF. `X-Forms-Failed`
   * is the one that matters — a package rendered without its I-864 must not
   * look identical to a complete one.
   */
  getCasePackagePdf = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = String(req.params.caseId);

    const { bytes, included, failed, provided, unplaced } =
      await formPdfService.fillPackageForCase(organizationId!, caseId, {
        flatten: req.query.flatten === "true",
      });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="filing-package-${caseId}.pdf"`,
    );
    res.setHeader(
      "X-Forms-Included",
      included.map((form) => form.formCode).join(","),
    );
    if (failed.length > 0) {
      res.setHeader(
        "X-Forms-Failed",
        failed.map((form) => `${form.formCode}: ${form.why}`).join("; "),
      );
    }
    if (provided.length > 0) {
      // Forms the package deliberately leaves out because somebody outside the
      // firm completes them — the I-693's sealed envelope. Named so the person
      // who just downloaded the package knows what still has to go in it.
      res.setHeader(
        "X-Forms-Provided",
        provided.map((form) => form.formCode).join(","),
      );
    }
    if (unplaced.length > 0) {
      res.setHeader(
        "X-Fields-Unplaced",
        unplaced
          .map((block) => `${block.source.base}[${block.source.index}]`)
          .join(","),
      );
    }
    res.send(bytes);
  });

  getCasePitfalls = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = String(req.params.caseId);

    // Every rule here is an I-485 pre-filing rule — the affidavit of support,
    // the medical exam, the form editions filed with the package. Run against a
    // naturalization or mandamus matter they answer a question nobody asked.
    await requireAdjustmentPackage(caseId, organizationId!);

    const today = new Date().toISOString().slice(0, 10);
    const pitfalls = await checkCase(caseId, today);
    sendSuccess(res, pitfalls, "Case validation checks retrieved successfully");
  });

  /**
   * What the AOS package costs, quoted against the matter's own filing date.
   *
   * The forms filed alongside the I-485 get the concurrent rate — an I-765 is
   * $260 that way and $520 alone, so which list a form is in changes the number
   * a client is told.
   */
  getCaseFilingFees = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const caseId = String(req.params.caseId);

    // The quote is for I-130/I-485/I-765/I-131 specifically. A case type whose
    // workflow never assembles that package has no package to be quoted.
    await requireAdjustmentPackage(caseId, organizationId!);

    const details = await getImmigrationDetails(caseId, organizationId!);
    const [caseRow] = await db
      .select({ filingDate: cases.filingDate })
      .from(cases)
      .where(
        and(eq(cases.id, caseId), eq(cases.organizationId, organizationId!)),
      )
      .limit(1);
    if (!caseRow) throw new NotFoundError("Case not found");

    const concurrent =
      details?.filingTrack === "concurrent" || details?.priorityDateIsCurrent;

    const quotes = await quoteFees({
      formCodes: [...AOS_PACKAGE_FORMS],
      filingMethod: "paper",
      // Only the forms that actually ride along with the I-485.
      withPendingI485: concurrent ? ["I-765", "I-131"] : [],
      on: caseRow.filingDate ?? new Date().toISOString().slice(0, 10),
    });

    sendSuccess(res, quotes, "Filing fees retrieved successfully");
  });

  getPersonalInjuryDetails = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const details = await getPersonalInjuryDetails(
      String(req.params.caseId),
      organizationId!,
    );
    sendSuccess(
      res,
      details,
      "Personal injury case details retrieved successfully",
    );
  });

  upsertPersonalInjuryDetails = asyncWrap(
    async (req: Request, res: Response) => {
      const { organizationId, staffId } = getRequestContext();

      const saved = await upsertPersonalInjuryDetails({
        caseId: String(req.params.caseId),
        organizationId: organizationId!,
        patch: req.body,
        actorStaffId: staffId ?? null,
      });

      sendSuccess(
        res,
        saved,
        "Personal injury case details saved successfully",
      );
    },
  );

  // ── The attorney's review of the filing package ───────────────────────────
  //
  // See `form-review.service.ts`. The endpoints are thin on purpose: every rule
  // — who may mark, what approval requires, what a mark does to the package's
  // status — lives in the service, because `updateCaseForm` has to obey the same
  // ones without going through a route.

  getFilingReview = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const review = await getFilingReview(
      String(req.params.caseId),
      organizationId!,
    );
    sendSuccess(res, review, "Filing review retrieved successfully");
  });

  requestFilingReview = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await requestReview(
      String(req.params.caseId),
      organizationId!,
    );
    sendSuccess(res, result, "Filing package sent for review");
  });

  approveFilingReview = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await approveFiling(
      String(req.params.caseId),
      organizationId!,
    );
    sendSuccess(res, result, "Filing package approved");
  });

  raiseFormCorrection = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const created = await raiseCorrection({
      caseId: String(req.params.caseId),
      organizationId: organizationId!,
      ...req.body,
    });
    sendSuccess(res, created, "Correction raised", 201);
  });

  resolveFormCorrection = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await resolveCorrection({
      correctionId: String(req.params.correctionId),
      organizationId: organizationId!,
      note: req.body.note,
    });
    sendSuccess(res, result, "Correction resolved");
  });

  reopenFormCorrection = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await reopenCorrection({
      correctionId: String(req.params.correctionId),
      organizationId: organizationId!,
      note: req.body.note,
    });
    sendSuccess(res, result, "Correction reopened");
  });

  commentOnFormCorrection = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const created = await commentOnCorrection({
      correctionId: String(req.params.correctionId),
      organizationId: organizationId!,
      body: req.body.body,
    });
    sendSuccess(res, created, "Comment added", 201);
  });
}
