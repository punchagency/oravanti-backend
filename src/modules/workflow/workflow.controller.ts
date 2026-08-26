import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
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
import { listCaseMilestones, recordCaseMilestone } from "./case-milestone.service";
import {
  ensurePackageForms,
  listCaseForms,
  packageProgress,
  removeCaseForm,
  updateCaseForm,
} from "./case-forms.service";
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
    const result = await this.workflowService.getLogs(
      caseId,
      organizationId!,
    );
    sendSuccess(res, result, "Logs retrieved successfully");
  });

  // Case Notes

  createNote = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const { workflowModuleId, taskId, category, visibility, isPinned, context, content } =
      req.body;
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
    sendSuccess(res, result.data, "Notes retrieved successfully", 200, { pagination: result.pagination });
  });

  updateNote = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const noteId = req.params.noteId as string;
    const { content, category, visibility, isPinned } = req.body;
    const result = await this.workflowService.updateNote(noteId, caseId, {
      content,
      category,
      visibility,
      isPinned,
    }, staffId ?? undefined, organizationId ?? undefined);
    sendSuccess(res, result, "Note updated successfully");
  });

  deleteNote = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const noteId = req.params.noteId as string;
    await this.workflowService.deleteNote(noteId, caseId, staffId ?? undefined, organizationId ?? undefined);
    sendSuccess(res, null, "Note deleted successfully");
  });

  toggleNotePin = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const caseId = req.params.caseId as string;
    const noteId = req.params.noteId as string;
    const actorId = staffId ?? undefined;
    const result = await this.workflowService.toggleNotePin(noteId, caseId, organizationId ?? undefined, actorId ?? undefined);
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
    await this.workflowService.bulkDeleteNotes(noteIds, caseId, organizationId ?? undefined, actorId ?? undefined);
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
    await this.workflowService.bulkPinNotes(noteIds, caseId, pinned, organizationId ?? undefined, actorId ?? undefined);
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
    const details = await getImmigrationDetails(String(req.params.caseId), organizationId!);
    sendSuccess(res, details, "Immigration case details retrieved successfully");
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
    const milestones = await listCaseMilestones(String(req.params.caseId), organizationId!);
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
      .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId!)))
      .limit(1);
    if (!caseRow) throw new NotFoundError("Case not found");

    const concurrent = details?.filingTrack === "concurrent" || details?.priorityDateIsCurrent;

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
    const details = await getPersonalInjuryDetails(String(req.params.caseId), organizationId!);
    sendSuccess(res, details, "Personal injury case details retrieved successfully");
  });

  upsertPersonalInjuryDetails = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();

    const saved = await upsertPersonalInjuryDetails({
      caseId: String(req.params.caseId),
      organizationId: organizationId!,
      patch: req.body,
      actorStaffId: staffId ?? null,
    });

    sendSuccess(res, saved, "Personal injury case details saved successfully");
  });
}