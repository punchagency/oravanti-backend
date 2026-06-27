import { Request, Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { parsePaginationQuery } from "../../utils/pagination";
import { LeadsService } from "./leads.service";

export class LeadsController {
  private svc: LeadsService;

  constructor(leadsService: LeadsService) {
    this.svc = leadsService;
  }

  createLead = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.createLead(req.organizationId!, req.body);
    res.status(201).json({ success: true, data: lead });
  };

  getAllLeads = async (req: AuthRequest, res: Response) => {
    const { stage, status, practiceAreaId, source, search, all } = req.query;
    const pagination = all ? {} : parsePaginationQuery(req.query);
    const result = await this.svc.getAllLeads(req.organizationId!, {
      ...pagination,
      stage: stage as string | undefined,
      status: status as string | undefined,
      practiceAreaId: practiceAreaId as string | undefined,
      source: source as string | undefined,
      search: search as string | undefined,
      all: all === "true",
    });
    res.json({ success: true, data: result });
  };

  getLeadStageCounts = async (req: AuthRequest, res: Response) => {
    const counts = await this.svc.getLeadStageCounts(req.organizationId!);
    res.json({ success: true, data: counts });
  };

  getLeadById = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.getLeadById(
      req.params.id as string,
      req.organizationId!,
    );
    if (!lead)
      return res.status(404).json({ success: false, error: "Lead not found" });
    res.json({ success: true, data: lead });
  };

  updateLead = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.updateLead(
      req.params.id as string,
      req.organizationId!,
      req.body,
    );
    res.json({ success: true, data: lead });
  };

  updateLeadStatus = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.updateLeadStatus(
      req.params.id as string,
      req.organizationId!,
      req.body.status
    );
    res.json({ success: true, data: lead });
  };

  advanceLeadStage = async (req: AuthRequest, res: Response) => {
    const lead = await this.svc.advanceLeadStage(
      req.params.id as string,
      req.organizationId!,
      req.body.stage,
    );
    res.json({ success: true, data: lead });
  };

  // ─── Conflict Check ──────────────────────────────────────────────────────────

  runConflictCheck = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.runConflictCheck(
      req.params.id as string,
      req.organizationId!,
      req.staffId,
    );
    res.json({ success: true, data: result });
  };

  getConflictCheck = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getConflictCheck(
      req.params.id as string,
      req.organizationId!,
    );
    res.json({ success: true, data: result });
  };

  resolveConflictCheck = async (req: AuthRequest, res: Response) => {
    const staffId = req.staffId;
    const result = await this.svc.resolveConflictCheck(
      req.params.id as string,
      req.organizationId!,
      staffId!,
      req.body,
    );
    res.json({ success: true, data: result });
  };

  // ─── Questionnaire ───────────────────────────────────────────────────────────

  sendQuestionnaire = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.sendQuestionnaire(
      req.params.id as string,
      req.organizationId!,
      req.staffId,
      req.body ?? {},
    );
    res.json({ success: true, data: result });
  };

  getLeadQuestionnaire = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getLeadQuestionnaire(
      req.params.id as string,
      req.organizationId!,
    );
    res.json({ success: true, data: result });
  };

  // ─── Consultation ────────────────────────────────────────────────────────────

  createConsultation = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.createConsultation(
      req.params.id as string,
      req.organizationId!,
      {
        ...req.body,
        scheduledAt: new Date(req.body.scheduledAt),
      },
    );
    res.status(201).json({ success: true, data: result });
  };

  getConsultation = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getConsultation(
      req.params.id as string,
      req.organizationId!,
    );
    res.json({ success: true, data: result });
  };

  updateConsultation = async (req: AuthRequest, res: Response) => {
    const body = { ...req.body };
    if (body.scheduledAt) body.scheduledAt = new Date(body.scheduledAt);
    const result = await this.svc.updateConsultation(
      req.params.id as string,
      req.organizationId!,
      body,
    );
    res.json({ success: true, data: result });
  };

  // ─── Fee Agreement ───────────────────────────────────────────────────────────

  generateFeeAgreement = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.generateFeeAgreement(
      req.params.id as string,
      req.organizationId!,
      req.body,
    );
    res.status(201).json({ success: true, data: result });
  };

  getFeeAgreement = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.getFeeAgreement(
      req.params.id as string,
      req.organizationId!,
    );
    res.json({ success: true, data: result });
  };

  nudgeClient = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.nudgeClient(
      req.params.agreementId as string,
      req.organizationId!,
    );
    res.json({ success: true, data: result });
  };

  sendFeeAgreement = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.sendFeeAgreement(
      req.params.agreementId as string,
      req.organizationId!,
    );
    res.json({ success: true, data: result });
  };

  markFeeAgreementReceived = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.markFeeAgreementReceived(
      req.params.agreementId as string,
      req.organizationId!,
    );
    res.json({ success: true, data: result });
  };

  // ─── eSignature Webhook (public) ─────────────────────────────────────────────

  handleESignatureWebhook = async (req: Request, res: Response) => {
    const result = await this.svc.handleESignatureWebhook(req.body);
    res.json({ success: true, data: result });
  };

  // ─── Case Opening ─────────────────────────────────────────────────────────────

  openCase = async (req: AuthRequest, res: Response) => {
    const result = await this.svc.openCase(
      req.params.id as string,
      req.organizationId!,
      req.body,
      req.adminId,
    );
    res.status(201).json({ success: true, data: result });
  };

  // ─── Case Workflow Steps ─────────────────────────────────────────────────────

  getCaseWorkflowSteps = async (req: AuthRequest, res: Response) => {
    const steps = await this.svc.getCaseWorkflowSteps(
      req.params.caseId as string,
      req.organizationId!,
    );
    res.json({ success: true, data: steps });
  };

  updateCaseWorkflowStep = async (req: AuthRequest, res: Response) => {
    const step = await this.svc.updateCaseWorkflowStep(
      req.params.caseId as string,
      req.params.stepId as string,
      req.organizationId!,
      req.body,
    );
    res.json({ success: true, data: step });
  };

  // ─── Adverse Parties ─────────────────────────────────────────────────────────

  getAdverseParties = async (req: AuthRequest, res: Response) => {
    const parties = await this.svc.getAdverseParties(
      req.params.caseId as string,
      req.organizationId!,
    );
    res.json({ success: true, data: parties });
  };

  addAdverseParty = async (req: AuthRequest, res: Response) => {
    const party = await this.svc.addAdverseParty(
      req.params.caseId as string,
      req.organizationId!,
      req.body,
    );
    res.status(201).json({ success: true, data: party });
  };

  updateAdverseParty = async (req: AuthRequest, res: Response) => {
    const party = await this.svc.updateAdverseParty(
      req.params.caseId as string,
      req.params.partyId as string,
      req.organizationId!,
      req.body,
    );
    res.json({ success: true, data: party });
  };

  deleteAdverseParty = async (req: AuthRequest, res: Response) => {
    await this.svc.deleteAdverseParty(
      req.params.caseId as string,
      req.params.partyId as string,
      req.organizationId!,
    );
    res.json({ success: true });
  };
}
