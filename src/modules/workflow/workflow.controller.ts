import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError } from "../../utils/error/app-error";
import { sendSuccess } from "../../utils/send-success";
import { WorkflowService } from "./workflow.service";

export class WorkflowController {
  private workflowService: WorkflowService;

  constructor(workflowService: WorkflowService) {
    this.workflowService = workflowService;
  }

  getOrCreateWorkflow = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const result = await this.workflowService.getOrCreateWorkflow(
      caseId,
      req.organizationId!,
    );
    sendSuccess(res, result, "Workflow retrieved successfully");
  });

  getWorkflowSummary = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const result = await this.workflowService.getWorkflowSummary(
      caseId,
      req.organizationId!,
    );
    sendSuccess(res, result, "Workflow summary retrieved successfully");
  });

  completeStep = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { notes } = req.body;
    const result = await this.workflowService.completeStep(
      caseId,
      stepId,
      req.organizationId!,
      req.staffId ?? req.adminId,
      notes,
    );
    sendSuccess(res, result, "Step completed successfully");
  });

  submitForReview = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { notes } = req.body;
    const result = await this.workflowService.submitForReview(
      caseId,
      stepId,
      req.organizationId!,
      req.staffId ?? req.adminId,
      notes,
    );
    sendSuccess(res, result, "Step submitted for review successfully");
  });

  approveStep = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { notes } = req.body;
    const result = await this.workflowService.approveStep(
      caseId,
      stepId,
      req.organizationId!,
      req.staffId ?? req.adminId,
      notes,
    );
    sendSuccess(res, result, "Step approved successfully");
  });

  rejectStep = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { feedback } = req.body;
    const result = await this.workflowService.rejectStep(
      caseId,
      stepId,
      req.organizationId!,
      req.staffId ?? req.adminId,
      feedback,
    );
    sendSuccess(res, result, "Step rejected");
  });

  assignStep = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const stepId = req.params.stepId as string;
    const { staffId, overrideRationale } = req.body;
    if (!staffId) throw new BadRequestError("staffId is required");

    const result = await this.workflowService.assignStep(
      caseId,
      stepId,
      staffId,
      req.organizationId!,
      overrideRationale,
      req.staffId ?? req.adminId,
    );
    sendSuccess(res, result, "Step assigned successfully");
  });

  activateModule = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const moduleId = req.params.moduleId as string;
    const result = await this.workflowService.activateModule(
      caseId,
      moduleId,
      req.organizationId!,
    );
    sendSuccess(res, result, "Module activated successfully");
  });

  getTimeline = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const result = await this.workflowService.getTimeline(
      caseId,
      req.organizationId!,
    );
    sendSuccess(res, result, "Timeline retrieved successfully");
  });

  getLogs = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const result = await this.workflowService.getLogs(
      caseId,
      req.organizationId!,
    );
    sendSuccess(res, result, "Logs retrieved successfully");
  });

  // ─── My Tasks ───────────────────────────────────────────────────────────────────

  getMyTasks = asyncWrap(async (req: AuthRequest, res: Response) => {
    console.log(req.staffId);

    if (!req.staffId) {
      sendSuccess(res, [], "My tasks retrieved successfully", 200, { pagination: { total: 0, limit: 10, offset: 0 } });
      return;
    }
    const status = req.query.status as string | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 10;
    const result = await this.workflowService.getMyTasks(
      req.staffId,
      req.organizationId!,
      status,
      page,
      limit,
    );
    const { data, pagination, counts } = result;
    sendSuccess(res, data, "My tasks retrieved successfully", 200, { pagination, counts });
  });

  // ─── Review Queue ───────────────────────────────────────────────────────────────

  getReviewQueue = asyncWrap(async (req: AuthRequest, res: Response) => {
    const status = req.query.status as string | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 10;
    const result = await this.workflowService.getReviewQueue(
      req.organizationId!,
      status,
      page,
      limit,
    );
    const { data, pagination, counts } = result;
    sendSuccess(res, data, "Review queue retrieved successfully", 200, { pagination, counts });
  });

  // ─── Case Notes ─────────────────────────────────────────────────────────────────

  createNote = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const { workflowModuleId, taskId, category, visibility, content } =
      req.body;
    if (!content) throw new BadRequestError("content is required");

    const result = await this.workflowService.createNote({
      caseId,
      organizationId: req.organizationId!,
      workflowModuleId,
      taskId,
      category,
      visibility,
      content,
      createdByUserId: req.staffId ?? req.adminId ?? req.user?.id ?? "",
    });
    sendSuccess(res, result, "Note created successfully", 201);
  });

  getNotes = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const result = await this.workflowService.getNotes(caseId);
    sendSuccess(res, result, "Notes retrieved successfully");
  });

  updateNote = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const noteId = req.params.noteId as string;
    const { content, category, visibility } = req.body;
    const result = await this.workflowService.updateNote(noteId, caseId, {
      content,
      category,
      visibility,
    });
    sendSuccess(res, result, "Note updated successfully");
  });

  deleteNote = asyncWrap(async (req: AuthRequest, res: Response) => {
    const caseId = req.params.caseId as string;
    const noteId = req.params.noteId as string;
    await this.workflowService.deleteNote(noteId, caseId);
    sendSuccess(res, null, "Note deleted successfully");
  });
}
