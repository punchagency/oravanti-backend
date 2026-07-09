import { Request, Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { parsePaginationQuery } from "../../utils/pagination";
import { sendSuccess } from "../../utils/send-success";
import { LeadsService } from "./leads.service";

export class LeadsController {
  private svc: LeadsService;

  constructor(leadsService: LeadsService) {
    this.svc = leadsService;
  }

  createLead = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.createLead(req.organizationId!, req.body);
    sendSuccess(res, lead, "Lead created successfully", 201);
  };

  getAllLeads = async (req: AuthRequest, res: Response) => {
    const { stage, status, practiceAreaId, source, search, all } = req.query;
    const queryPagination = all ? {} : parsePaginationQuery(req.query);
    const result = await this.svc.getAllLeads(req.organizationId!, {
      ...queryPagination,
      stage: stage as string | undefined,
      status: status as string | undefined,
      practiceAreaId: practiceAreaId as string | undefined,
      source: source as string | undefined,
      search: search as string | undefined,
      all: all === "true",
    });
    if (all === "true") {
      sendSuccess(res, result, "Leads retrieved successfully");
      return;
    }
    const r = result as { leads: unknown; pagination: unknown };
    sendSuccess(res, r.leads, "Leads retrieved successfully", 200, { pagination: r.pagination });
  };

  getLeadStageCounts = async (req: AuthRequest, res: Response) => {
    const counts = await this.svc.getLeadStageCounts(req.organizationId!);
    sendSuccess(res, counts, "Stage counts retrieved successfully");
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
    );
    sendSuccess(res, lead, "Lead updated successfully");
  };

  updateLeadStatus = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.updateLeadStatus(
      req.params.id as string,
      req.organizationId!,
      req.body.status
    );
    sendSuccess(res, lead, "Lead status updated successfully");
  };

  advanceLeadStage = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.advanceLeadStage(
      req.params.id as string,
      req.organizationId!,
      req.body.stage,
    );
    sendSuccess(res, lead, "Lead stage advanced successfully");
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
    sendSuccess(res, data, "Consultations retrieved successfully", 200, { pagination });
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
    );
    sendSuccess(res, result, "Consultation updated successfully");
  };

  cancelConsultation = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.cancelConsultation(
      req.params.id as string,
      req.organizationId!,
      { reason: req.body?.reason },
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
    const result = await this.svc.updateLeadTimezoneByBookingToken(
      req.params.token as string,
      req.body.timezone,
    );
    sendSuccess(res, result, "Timezone updated successfully");
  };

  // ─── Fee Agreement ───────────────────────────────────────────────────────────

  generateFeeAgreement = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.generateFeeAgreement(
      req.params.id as string,
      req.organizationId!,
      req.body,
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
    );
    sendSuccess(res, result, "Fee agreement sent successfully");
  };

  markFeeAgreementReceived = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.markFeeAgreementReceived(
      req.params.agreementId as string,
      req.organizationId!,
    );
    sendSuccess(res, result, "Fee agreement marked as received");
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

  openCase = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.openCase(
      req.params.id as string,
      req.organizationId!,
      req.body,
      req.adminId,
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
}
