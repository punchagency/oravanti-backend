import { Request, Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { parsePaginationQuery } from "../../utils/pagination";
import { sendSuccess } from "../../utils/send-success";
import { LeadWorkflowService } from "./lead-workflow.service";
import { LeadsService } from "./leads.service";

export class LeadsController {
  private svc: LeadsService;
  private wfSvc: LeadWorkflowService;

  constructor(
    leadsService: LeadsService,
    workflowService?: LeadWorkflowService,
  ) {
    this.svc = leadsService;
    this.wfSvc = workflowService ?? new LeadWorkflowService();
  }

  createLead = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.createLead(
      req.organizationId!,
      req.body,
      req.staffId!,
    );
    sendSuccess(res, lead, "Lead created successfully", 201);
  };

  getAllLeads = async (req: AuthRequest, res: Response) => {
    const { stage, status, practiceAreaId, source, search, converted, all } =
      req.query;
    const queryPagination = all ? {} : parsePaginationQuery(req.query);
    const result = await this.svc.getAllLeads(req.organizationId!, {
      ...queryPagination,
      stage: stage as string | undefined,
      status: status as string | undefined,
      practiceAreaId: practiceAreaId as string | undefined,
      source: source as string | undefined,
      search: search as string | undefined,
      converted: converted === undefined ? undefined : converted === "true",
      all: all === "true",
    });
    if (all === "true") {
      sendSuccess(res, result, "Leads retrieved successfully");
      return;
    }
    const r = result as { leads: unknown; pagination: unknown };
    sendSuccess(res, r.leads, "Leads retrieved successfully", 200, {
      pagination: r.pagination,
    });
  };

  getLeadStageCounts = async (req: AuthRequest, res: Response) => {
    const counts = await this.svc.getLeadStageCounts(req.organizationId!);
    sendSuccess(res, counts, "Stage counts retrieved successfully");
  };

  getLeadMetrics = async (req: AuthRequest, res: Response) => {
    const metrics = await this.svc.getLeadMetrics(
      req.organizationId!,
      (req.query.period as "30d" | "90d" | "12mo") ?? "30d",
    );
    sendSuccess(res, metrics, "Lead metrics retrieved successfully");
  };

  getLeadById = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.getLeadById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!lead)
      return res.status(404).json({ success: false, error: "Lead not found" });
    sendSuccess(res, lead, "Lead retrieved successfully");
  };

  updateLead = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.updateLead(
      req.params.id as string,
      req.organizationId!,
      req.body,
      req.staffId,
    );
    sendSuccess(res, lead, "Lead updated successfully");
  };

  updateLeadStatus = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.updateLeadStatus(
      req.params.id as string,
      req.organizationId!,
      req.body.status,
      req.staffId,
    );
    sendSuccess(res, lead, "Lead status updated successfully");
  };

  advanceLeadStage = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.advanceLeadStage(
      req.params.id as string,
      req.organizationId!,
      req.body.stage,
      req.staffId,
    );
    sendSuccess(res, lead, "Lead stage advanced successfully");
  };

  getLeadActivity = async (req: AuthRequest, res: Response) => {
    const events = await this.svc.getLeadActivity(
      req.params.id as string,
      req.organizationId!,
    );
    sendSuccess(res, events, "Lead activity retrieved successfully");
  };

  // ─── Notes ────────────────────────────────────────────────────────────────

  getLeadNotes = async (req: AuthRequest, res: Response) => {
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const notes = await this.svc.getLeadNotes(leadId, req.organizationId!);
    sendSuccess(res, notes, "Lead notes retrieved successfully");
  };

  addLeadNote = async (req: AuthRequest, res: Response) => {
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const note = await this.svc.addLeadNote(
      leadId,
      req.organizationId!,
      req.body,
      req.staffId,
    );
    sendSuccess(res, note, "Note added successfully", 201);
  };

  createLeadNote = async (req: AuthRequest, res: Response) => {
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const note = await this.svc.addLeadNote(
      leadId,
      req.organizationId!,
      req.body,
      req.staffId,
    );
    sendSuccess(res, note, "Note created successfully", 201);
  };

  updateLeadNote = async (req: AuthRequest, res: Response) => {
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const note = await this.svc.updateLeadNote(
      req.params.noteId as string,
      leadId,
      req.organizationId!,
      req.body,
      req.staffId!,
    );
    sendSuccess(res, note, "Note updated successfully");
  };

  deleteLeadNote = async (req: AuthRequest, res: Response) => {
    const leadId = (req.params.leadId ?? req.params.id) as string;
    await this.svc.deleteLeadNote(
      req.params.noteId as string,
      leadId,
      req.organizationId!,
      req.staffId!,
    );
    sendSuccess(res, null, "Note deleted successfully");
  };

  // ─── Archive / restore ──────────────────────────────────────────────────────

  archiveLead = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.archiveLead(
      req.params.id as string,
      req.organizationId!,
      { reason: req.body?.reason },
      req.staffId,
    );
    sendSuccess(res, lead, "Lead archived successfully");
  };

  restoreLead = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.restoreLead(
      req.params.id as string,
      req.organizationId!,
      req.staffId,
    );
    sendSuccess(res, lead, "Lead restored successfully");
  };

  // ─── Conflict Check ──────────────────────────────────────────────────────────

  runConflictCheck = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.runConflictCheck(
      req.params.id as string,
      req.organizationId!,
      req.staffId,
    );
    sendSuccess(res, result, "Conflict check completed successfully");
  };

  getConflictCheck = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getConflictCheck(
      req.params.id as string,
      req.organizationId!,
    );
    sendSuccess(res, result, "Conflict check retrieved successfully");
  };

  resolveConflictCheck = async (req: AuthRequest, res: Response) => {
    const staffId = req.staffId;
    const result = await this.svc.resolveConflictCheck(
      req.params.id as string,
      req.organizationId!,
      staffId!,
      req.body,
    );
    sendSuccess(res, result, "Conflict check resolved successfully");
  };

  // ─── Questionnaire ───────────────────────────────────────────────────────────

  sendQuestionnaire = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.sendQuestionnaire(
      req.params.id as string,
      req.organizationId!,
      req.staffId,
      req.body ?? {},
    );
    sendSuccess(res, result, "Questionnaire sent successfully");
  };

  getLeadQuestionnaire = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getLeadQuestionnaire(
      req.params.id as string,
      req.organizationId!,
    );
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  };

  // ─── Consultation ────────────────────────────────────────────────────────────

  initiateConsultation = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.initiateConsultation(
      req.params.id as string,
      req.organizationId!,
      req.body,
      req.staffId,
    );
    sendSuccess(res, result, "Consultation initiated successfully", 201);
  };

  getConsultations = async (req: AuthRequest, res: Response) => {
    const { search, attorneyId, sort } = req.query;
    const queryPagination = parsePaginationQuery(req.query);
    const result = await this.svc.getConsultations(req.organizationId!, {
      ...queryPagination,
      search: search as string | undefined,
      attorneyId: attorneyId as string | undefined,
      sort: sort as string | undefined,
    });
    const { data, pagination } = result;
    sendSuccess(res, data, "Consultations retrieved successfully", 200, {
      pagination,
    });
  };

  getConsultation = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getConsultation(
      req.params.id as string,
      req.organizationId!,
    );
    sendSuccess(res, result, "Consultation retrieved successfully");
  };

  updateConsultation = async (req: AuthRequest, res: Response) => {
    const body = { ...req.body };
    if (body.scheduledAt) body.scheduledAt = new Date(body.scheduledAt);
    const result = await this.svc.updateConsultation(
      req.params.id as string,
      req.organizationId!,
      body,
      req.staffId,
    );
    sendSuccess(res, result, "Consultation updated successfully");
  };

  cancelConsultation = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.cancelConsultation(
      req.params.id as string,
      req.organizationId!,
      { reason: req.body?.reason },
      req.staffId,
    );
    sendSuccess(res, result, "Consultation cancelled successfully");
  };

  // ─── Public booking flow (token-gated, no auth) ──────────────────────────────

  getConsultationBooking = async (req: Request, res: Response) => {
    const result = await this.svc.getConsultationBooking(
      req.params.token as string,
    );
    sendSuccess(res, result, "Booking data retrieved successfully");
  };

  payConsultationFee = async (req: Request, res: Response) => {
    const result = await this.svc.payConsultationFee(
      req.params.token as string,
    );
    sendSuccess(res, result, "Payment processed successfully");
  };

  selectConsultationSlot = async (req: Request, res: Response) => {
    const result = await this.svc.selectConsultationSlot(
      req.params.token as string,
      req.body.start,
    );
    sendSuccess(res, result, "Slot selected successfully");
  };

  updateBookingTimezone = async (req: Request, res: Response) => {
    sendSuccess(res, null, "Timezone updated successfully");
  };

  // ─── Fee Agreement ───────────────────────────────────────────────────────────

  generateFeeAgreement = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.generateFeeAgreement(
      req.params.id as string,
      req.organizationId!,
      req.body,
      req.staffId,
    );
    sendSuccess(res, result, "Fee agreement generated successfully", 201);
  };

  getFeeAgreement = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getFeeAgreement(
      req.params.id as string,
      req.organizationId!,
    );
    sendSuccess(res, result, "Fee agreement retrieved successfully");
  };

  getFeeAgreementPreview = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getFeeAgreementPreview(
      req.params.agreementId as string,
      req.organizationId!,
    );
    sendSuccess(res, result, "Fee agreement preview retrieved successfully");
  };

  nudgeClient = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.nudgeClient(
      req.params.agreementId as string,
      req.organizationId!,
    );
    sendSuccess(res, result, "Client nudged successfully");
  };

  sendFeeAgreement = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.sendFeeAgreement(
      req.params.agreementId as string,
      req.organizationId!,
      req.staffId,
    );
    sendSuccess(res, result, "Fee agreement sent successfully");
  };

  markFeeAgreementReceived = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.markFeeAgreementReceived(
      req.params.agreementId as string,
      req.organizationId!,
      req.staffId,
    );
    sendSuccess(res, result, "Fee agreement marked as received");
  };

  markFeeAgreementPaymentReceived = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.markFeeAgreementPaymentReceived(
      req.params.agreementId as string,
      req.organizationId!,
      req.staffId,
    );
    res.json({ success: true, data: result });
  };

  discardDraftFeeAgreement = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.discardDraftFeeAgreement(
      req.params.agreementId as string,
      req.organizationId!,
    );
    res.json({ success: true, data: result });
  };

  // ─── Embedded signing session (public, token-gated) ─────────────────────────

  getEmbeddedSignSession = async (req: Request, res: Response) => {
    const result = await this.svc.getEmbeddedSignSession(
      req.params.token as string,
    );
    sendSuccess(res, result, "Signing session retrieved successfully");
  };

  // ─── Dropbox Sign Webhook (public) ──────────────────────────────────────────

  handleDropboxSignWebhook = async (req: Request, res: Response) => {
    const raw = (req.body as { json?: string })?.json;
    if (!raw) {
      res.status(400).send("Missing event payload");
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.status(400).send("Invalid event payload");
      return;
    }
    await this.svc.handleDropboxSignWebhook(payload as never);
    res.status(200).send("Hello API Event Received");
  };

  // ─── Case Opening ─────────────────────────────────────────────────────────────

  getEligibleTeamsForLead = async (req: AuthRequest, res: Response) => {
    const teams = await this.svc.getEligibleTeamsForLead(
      req.params.id as string,
      req.organizationId!,
    );
    sendSuccess(res, teams, "Eligible teams retrieved");
  };

  openCase = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.openCase(
      req.params.id as string,
      req.organizationId!,
      req.body,
      req.staffId!,
    );
    sendSuccess(res, result, "Case opened successfully", 201);
  };

  // ─── Case Workflow Steps ─────────────────────────────────────────────────────

  getCaseWorkflowSteps = async (req: AuthRequest, res: Response) => {
    const steps = await this.svc.getCaseWorkflowSteps(
      req.params.caseId as string,
      req.organizationId!,
    );
    sendSuccess(res, steps, "Workflow steps retrieved successfully");
  };

  updateCaseWorkflowStep = async (req: AuthRequest, res: Response) => {
    const step = await this.svc.updateCaseWorkflowStep(
      req.params.caseId as string,
      req.params.stepId as string,
      req.organizationId!,
      req.body,
    );
    sendSuccess(res, step, "Workflow step updated successfully");
  };

  // ─── Adverse Parties ─────────────────────────────────────────────────────────

  getAdverseParties = async (req: AuthRequest, res: Response) => {
    const parties = await this.svc.getAdverseParties(
      req.params.caseId as string,
      req.organizationId!,
    );
    sendSuccess(res, parties, "Adverse parties retrieved successfully");
  };

  addAdverseParty = async (req: AuthRequest, res: Response) => {
    const party = await this.svc.addAdverseParty(
      req.params.caseId as string,
      req.organizationId!,
      req.body,
    );
    sendSuccess(res, party, "Adverse party added successfully", 201);
  };

  updateAdverseParty = async (req: AuthRequest, res: Response) => {
    const party = await this.svc.updateAdverseParty(
      req.params.caseId as string,
      req.params.partyId as string,
      req.organizationId!,
      req.body,
    );
    sendSuccess(res, party, "Adverse party updated successfully");
  };

  deleteAdverseParty = async (req: AuthRequest, res: Response) => {
    await this.svc.deleteAdverseParty(
      req.params.caseId as string,
      req.params.partyId as string,
      req.organizationId!,
    );
    sendSuccess(res, null, "Adverse party deleted successfully");
  };

  // ─── Lead Workflow Tasks ──────────────────────────────────────────────────────

  getMyLeadTasks = async (req: AuthRequest, res: Response) => {
    const tasks = await this.wfSvc.getMyTasks(
      req.staffId!,
      req.organizationId!,
    );
    sendSuccess(res, tasks, "My tasks retrieved successfully");
  };

  initializePipeline = async (req: AuthRequest, res: Response) => {
    const steps = await this.wfSvc.initializePipelineSteps(
      req.params.leadId as string,
      req.organizationId!,
    );
    sendSuccess(res, steps, "Pipeline steps initialized successfully");
  };

  getLeadTasks = async (req: AuthRequest, res: Response) => {
    const tasks = await this.wfSvc.getTasks(
      req.params.leadId as string,
      req.organizationId!,
    );
    sendSuccess(res, tasks, "Lead tasks retrieved successfully");
  };

  createLeadTask = async (req: AuthRequest, res: Response) => {
    const task = await this.wfSvc.createTask(
      { ...req.body, leadId: req.params.leadId },
      req.organizationId!,
    );
    sendSuccess(res, task, "Task created successfully", 201);
  };

  updateLeadTask = async (req: AuthRequest, res: Response) => {
    const task = await this.wfSvc.updateTask(
      req.params.taskId as string,
      req.body,
      req.organizationId!,
    );
    sendSuccess(res, task, "Task updated successfully");
  };

  updateLeadTaskStatus = async (req: AuthRequest, res: Response) => {
    const task = await this.wfSvc.updateTaskStatus(
      req.params.taskId as string,
      req.body.status,
      req.organizationId!,
    );
    sendSuccess(res, task, "Task status updated successfully");
  };

  assignLeadTask = async (req: AuthRequest, res: Response) => {
    const task = await this.wfSvc.assignTask(
      req.params.taskId as string,
      req.body.assignedToId,
      req.organizationId!,
    );
    sendSuccess(res, task, "Task assigned successfully");
  };

  completeLeadTask = async (req: AuthRequest, res: Response) => {
    const task = await this.wfSvc.completeTask(
      req.params.taskId as string,
      req.staffId!,
      req.organizationId!,
    );
    sendSuccess(res, task, "Task completed successfully");
  };

  submitLeadTaskForReview = async (req: AuthRequest, res: Response) => {
    const task = await this.wfSvc.submitTaskForReview(
      req.params.taskId as string,
      req.staffId!,
      req.body.notes,
      req.organizationId!,
    );
    sendSuccess(res, task, "Task submitted for review");
  };

  approveLeadTask = async (req: AuthRequest, res: Response) => {
    const task = await this.wfSvc.approveTask(
      req.params.taskId as string,
      req.staffId!,
      req.body.notes,
      req.organizationId!,
    );
    sendSuccess(res, task, "Task approved");
  };

  rejectLeadTask = async (req: AuthRequest, res: Response) => {
    const task = await this.wfSvc.rejectTask(
      req.params.taskId as string,
      req.staffId!,
      req.body.feedback,
      req.organizationId!,
    );
    sendSuccess(res, task, "Task rejected");
  };

  getLeadReviewQueue = async (req: AuthRequest, res: Response) => {
    const status = req.query.status as string | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 20;
    const result = await this.wfSvc.getReviewQueue(
      req.organizationId!,
      status,
      page,
      limit,
    );
    sendSuccess(res, result.items, "Review queue retrieved", 200, {
      pagination: result.pagination,
    });
  };

  deleteLeadTask = async (req: AuthRequest, res: Response) => {
    await this.wfSvc.deleteTask(
      req.params.taskId as string,
      req.organizationId!,
    );
    sendSuccess(res, null, "Task deleted successfully");
  };

  // ─── Lead Timeline ────────────────────────────────────────────────────────────

  getLeadTimeline = async (req: AuthRequest, res: Response) => {
    const events = await this.wfSvc.getTimelineEvents(
      req.params.leadId as string,
      req.organizationId!,
    );
    sendSuccess(res, events, "Timeline events retrieved successfully");
  };

  createLeadTimelineEvent = async (req: AuthRequest, res: Response) => {
    const event = await this.wfSvc.createTimelineEvent({
      leadId: req.params.leadId as string,
      eventType: req.body.eventType,
      title: req.body.title,
      description: req.body.description,
      metadata: req.body.metadata,
      createdById: req.staffId,
    });
    sendSuccess(res, event, "Timeline event created successfully", 201);
  };

  // ─── Lead Documents ───────────────────────────────────────────────────────────

  getLeadDocuments = async (req: AuthRequest, res: Response) => {
    const docs = await this.wfSvc.getLinkedDocuments(
      req.params.leadId as string,
      req.organizationId!,
    );
    sendSuccess(res, docs, "Linked documents retrieved successfully");
  };

  linkLeadDocument = async (req: AuthRequest, res: Response) => {
    const link = await this.wfSvc.linkDocument(
      req.body.documentId,
      req.params.leadId as string,
      req.staffId,
    );
    sendSuccess(res, link, "Document linked successfully", 201);
  };

  unlinkLeadDocument = async (req: AuthRequest, res: Response) => {
    await this.wfSvc.unlinkDocument(
      req.params.linkId as string,
      req.params.leadId as string,
    );
    sendSuccess(res, null, "Document unlinked successfully");
  };
}
