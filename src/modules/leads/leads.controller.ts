import { eq } from "drizzle-orm";
import { Request, Response } from "express";
import { db } from "../../db/client";
import { staff } from "../../db/schema/staff";
import { hasPermission } from "../../middleware/permission.middleware";
import { getRequestContext } from "../../middleware/request-context";
import { parsePaginationQuery } from "../../utils/pagination";
import { sendSuccess } from "../../utils/send-success";
import {
  getIntakePipelineTemplate,
  saveIntakePipelineSteps,
} from "./intake-pipeline-template.service";
import { logLeadView } from "./lead-events.service";
import { LeadWorkflowService } from "./lead-workflow.service";
import type { ConsultationCancellation } from "./leads.service";
import { LeadsService } from "./leads.service";

/**
 * Say what happened to the money, not just that the cancellation worked.
 *
 * A refund that did not happen is the thing the user most needs to know, and a
 * bare "Consultation cancelled successfully" actively hides it.
 */
const cancellationMessage = (c: ConsultationCancellation): string => {
  if (c.refundOwed > 0 && c.awaitingAdmin) {
    return `Consultation cancelled. ${c.refundOwed.toFixed(2)} is still owed to the client — an administrator needs to issue the refund.`;
  }
  if (c.manualOutstanding > 0) {
    return `Consultation cancelled and ${c.refunded.toFixed(2)} refunded. ${c.manualOutstanding.toFixed(2)} was paid outside the processor and has to be returned to the client directly.`;
  }
  if (c.refundOwed > 0) {
    return `Consultation cancelled, but ${c.refundOwed.toFixed(2)} could not be refunded automatically. Check the invoice.`;
  }
  if (c.refunded > 0) {
    return `Consultation cancelled and ${c.refunded.toFixed(2)} refunded to the client.`;
  }
  return "Consultation cancelled successfully";
};

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

  createLead = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const lead = await this.svc.createLead(
      organizationId!,
      req.body,
      staffId!,
    );
    sendSuccess(res, lead, "Lead created successfully", 201);
  };

  getAllLeads = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const { stage, status, practiceAreaId, source, search, converted, all } =
      req.query;
    const queryPagination = all ? {} : parsePaginationQuery(req.query);
    const result = await this.svc.getAllLeads(organizationId!, {
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

  getLeadStageCounts = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const counts = await this.svc.getLeadStageCounts(organizationId!);
    sendSuccess(res, counts, "Stage counts retrieved successfully");
  };

  getLeadMetrics = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const metrics = await this.svc.getLeadMetrics(
      organizationId!,
      (req.query.period as "30d" | "90d" | "12mo") ?? "30d",
    );
    sendSuccess(res, metrics, "Lead metrics retrieved successfully");
  };

  getLeadById = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const lead = await this.svc.getLeadById(
      req.params.id as string,
      organizationId!,
      staffId,
    );
    if (!lead)
      return res.status(404).json({ success: false, error: "Lead not found" });

    logLeadView(
      organizationId!,
      req.params.id as string,
      staffId,
      "overview",
    ).catch(() => {});

    sendSuccess(res, lead, "Lead retrieved successfully");
  };

  updateLead = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const lead = await this.svc.updateLead(
      req.params.id as string,
      organizationId!,
      req.body,
      staffId,
    );
    sendSuccess(res, lead, "Lead updated successfully");
  };

  updateLeadStatus = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const lead = await this.svc.updateLeadStatus(
      req.params.id as string,
      organizationId!,
      req.body.status,
      staffId,
    );
    sendSuccess(res, lead, "Lead status updated successfully");
  };

  advanceLeadStage = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const lead = await this.svc.advanceLeadStage(
      req.params.id as string,
      organizationId!,
      req.body.stage,
      staffId,
    );
    sendSuccess(res, lead, "Lead stage advanced successfully");
  };

  getLeadActivity = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const events = await this.svc.getLeadActivity(
      req.params.id as string,
      organizationId!,
    );
    logLeadView(
      organizationId!,
      req.params.id as string,
      staffId,
      "activity",
    ).catch(() => {});
    sendSuccess(res, events, "Lead activity retrieved successfully");
  };

  // Notes

  getLeadNotes = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const context = req.query.context as string | undefined;
    const authorId = req.query.authorId as string | undefined;
    const pinnedOnly = req.query.pinned === "true";
    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    // Look up user role for visibility filtering via staff table
    let userRole: string | undefined;
    if (staffId) {
      const [staffMember] = await db
        .select({ role: staff.role })
        .from(staff)
        .where(eq(staff.id, staffId))
        .limit(1);
      userRole = staffMember?.role ?? undefined;
    }

    const result = await this.svc.getLeadNotes(leadId, organizationId!, {
      context,
      authorId,
      userRole,
      pinnedOnly,
      page,
      limit,
    });
    logLeadView(organizationId!, leadId, staffId, "notes").catch(
      () => {},
    );
    sendSuccess(res, result.data, "Lead notes retrieved successfully", 200, {
      pagination: result.pagination,
    });
  };

  addLeadNote = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const note = await this.svc.addLeadNote(
      leadId,
      organizationId!,
      req.body,
      staffId,
    );
    sendSuccess(res, note, "Note added successfully", 201);
  };

  createLeadNote = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const note = await this.svc.addLeadNote(
      leadId,
      organizationId!,
      req.body,
      staffId,
    );
    sendSuccess(res, note, "Note created successfully", 201);
  };

  updateLeadNote = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const note = await this.svc.updateLeadNote(
      req.params.noteId as string,
      leadId,
      organizationId!,
      req.body,
      staffId!,
    );
    sendSuccess(res, note, "Note updated successfully");
  };

  deleteLeadNote = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const leadId = (req.params.leadId ?? req.params.id) as string;
    await this.svc.deleteLeadNote(
      req.params.noteId as string,
      leadId,
      organizationId!,
      staffId!,
    );
    sendSuccess(res, null, "Note deleted successfully");
  };

  bulkDeleteNotes = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const result = await this.svc.bulkDeleteNotes(
      leadId,
      req.body.noteIds,
      organizationId!,
      staffId!,
    );
    sendSuccess(res, result, `${result.deleted} note(s) deleted`);
  };

  bulkPinNotes = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const result = await this.svc.bulkPinNotes(
      leadId,
      req.body.noteIds,
      req.body.pinned,
      organizationId!,
      staffId!,
    );
    sendSuccess(res, result, `${result.updated} note(s) updated`);
  };

  toggleNotePin = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const leadId = (req.params.leadId ?? req.params.id) as string;
    const note = await this.svc.toggleNotePin(
      req.params.noteId as string,
      leadId,
      organizationId!,
      staffId!,
    );
    sendSuccess(res, note, "Note pin toggled");
  };

  // Archive / restore

  archiveLead = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const lead = await this.svc.archiveLead(
      req.params.id as string,
      organizationId!,
      { reason: req.body?.reason },
      staffId,
    );
    sendSuccess(res, lead, "Lead archived successfully");
  };

  restoreLead = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const lead = await this.svc.restoreLead(
      req.params.id as string,
      organizationId!,
      staffId,
    );
    sendSuccess(res, lead, "Lead restored successfully");
  };

  // Conflict Check

  runConflictCheck = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.runConflictCheck(
      req.params.id as string,
      organizationId!,
      staffId,
    );
    sendSuccess(res, result, "Conflict check completed successfully");
  };

  getLeadLayout = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getLeadLayout(
      req.params.id as string,
      organizationId!,
    );
    sendSuccess(res, result, "Lead layout retrieved successfully");
  };

  getConflictCheck = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.getConflictCheck(
      req.params.id as string,
      organizationId!,
    );
    logLeadView(
      organizationId!,
      req.params.id as string,
      staffId,
      "conflict-check",
    ).catch(() => {});
    sendSuccess(res, result, "Conflict check retrieved successfully");
  };

  resolveConflictCheck = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    // staffId already in context
    const result = await this.svc.resolveConflictCheck(
      req.params.id as string,
      organizationId!,
      staffId!,
      req.body,
    );
    sendSuccess(res, result, "Conflict check resolved successfully");
  };

  // Questionnaire

  sendQuestionnaire = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.sendQuestionnaire(
      req.params.id as string,
      organizationId!,
      staffId,
      req.body ?? {},
    );
    sendSuccess(res, result, "Questionnaire sent successfully");
  };

  getLeadQuestionnaire = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.getLeadQuestionnaire(
      req.params.id as string,
      organizationId!,
    );
    logLeadView(
      organizationId!,
      req.params.id as string,
      staffId,
      "questionnaire",
    ).catch(() => {});
    sendSuccess(res, result, "Questionnaire retrieved successfully");
  };

  // Consultation

  initiateConsultation = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.initiateConsultation(
      req.params.id as string,
      organizationId!,
      req.body,
      staffId,
    );
    sendSuccess(res, result, "Consultation initiated successfully", 201);
  };

  getConsultations = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const { search, attorneyId, sort } = req.query;
    const queryPagination = parsePaginationQuery(req.query);
    const result = await this.svc.getConsultations(organizationId!, {
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

  getConsultation = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.getConsultation(
      req.params.id as string,
      organizationId!,
    );
    logLeadView(
      organizationId!,
      req.params.id as string,
      staffId,
      "consultation",
    ).catch(() => {});
    sendSuccess(res, result, "Consultation retrieved successfully");
  };

  updateConsultation = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const body = { ...req.body };
    if (body.scheduledAt) body.scheduledAt = new Date(body.scheduledAt);
    // Needed only by the `refund` no-show policy, and asked here for the same
    // reason cancellation asks here: this is the only layer holding the request
    // headers Better Auth needs. Marking a no-show is an intake action and
    // refunding is a finance one, so the two come apart — anyone may mark it,
    // and the money waits visibly for someone who can move it.
    const canRefund = await hasPermission(req, { finance: ["refund"] });
    const result = await this.svc.updateConsultation(
      req.params.id as string,
      organizationId!,
      body,
      staffId,
      canRefund,
    );
    sendSuccess(res, result, "Consultation updated successfully");
  };

  cancelConsultation = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    // Anyone in intake may cancel; only an owner or admin may send the money
    // back. Resolved here because this is the only layer holding the request
    // headers Better Auth needs, and asked rather than enforced so the
    // cancellation still goes through either way.
    const canRefund = await hasPermission(req, { finance: ["refund"] });
    const result = await this.svc.cancelConsultation(
      req.params.id as string,
      organizationId!,
      { reason: req.body?.reason },
      staffId,
      canRefund,
    );
    sendSuccess(res, result, cancellationMessage(result.cancellation));
  };

  // Public booking flow (token-gated, no auth)

  getConsultationBooking = async (req: Request, res: Response) => {

    const result = await this.svc.getConsultationBooking(
      req.params.token as string,
    );
    sendSuccess(res, result, "Booking data retrieved successfully");
  };

  startConsultationPayment = async (req: Request, res: Response) => {

    const result = await this.svc.startConsultationPayment(
      req.params.token as string,
    );
    sendSuccess(res, result, "Payment session started");
  };

  selectConsultationSlot = async (req: Request, res: Response) => {

    const result = await this.svc.selectConsultationSlot(
      req.params.token as string,
      req.body.start,
    );
    sendSuccess(res, result, "Slot selected successfully");
  };

  updateBookingTimezone = async (req: Request, res: Response) => {
    await this.svc.updateBookingTimezone(
      req.params.token as string,
      req.body.timezone as string,
    );
    sendSuccess(res, null, "Timezone updated successfully");
  };

  // Fee Agreement

  generateFeeAgreement = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.generateFeeAgreement(
      req.params.id as string,
      organizationId!,
      req.body,
      staffId,
    );
    sendSuccess(res, result, "Fee agreement generated successfully", 201);
  };

  getFeeAgreement = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.getFeeAgreement(
      req.params.id as string,
      organizationId!,
      staffId,
    );
    logLeadView(
      organizationId!,
      req.params.id as string,
      staffId,
      "fee-agreement",
    ).catch(() => {});
    sendSuccess(res, result, "Fee agreement retrieved successfully");
  };

  getFeeAgreementPreview = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const result = await this.svc.getFeeAgreementPreview(
      req.params.agreementId as string,
      organizationId!,
    );
    sendSuccess(res, result, "Fee agreement preview retrieved successfully");
  };

  nudgeClient = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const result = await this.svc.nudgeClient(
      req.params.agreementId as string,
      organizationId!,
    );
    sendSuccess(res, result, "Client nudged successfully");
  };

  sendFeeAgreement = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.sendFeeAgreement(
      req.params.agreementId as string,
      organizationId!,
      staffId,
    );
    sendSuccess(res, result, "Fee agreement sent successfully");
  };

  listAgreementsAwaitingFirmSignature = async (
    _req: Request,
    res: Response,
  ) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.svc.listAgreementsAwaitingFirmSignature(
      organizationId!,
      staffId ?? null,
    );
    sendSuccess(res, result, "Agreements awaiting signature retrieved");
  };

  getFirmSignSession = async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const result = await this.svc.getFirmSignSession(
      req.params.agreementId as string,
      organizationId!,
      staffId ?? null,
    );
    sendSuccess(res, result, "Signing session created successfully");
  };

  remindFirmSigner = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.remindFirmSigner(
      req.params.agreementId as string,
      organizationId!,
    );
    sendSuccess(res, result, "Signer reminded successfully");
  };

  reassignFirmSigner = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.reassignFirmSigner(
      req.params.agreementId as string,
      organizationId!,
      req.body.firmSignerStaffId as string,
      staffId,
    );
    sendSuccess(res, result, "Fee agreement signer changed successfully");
  };

  getFeeAgreementSignedDocument = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.svc.getFeeAgreementSignedDocument(
      req.params.agreementId as string,
      organizationId!,
    );
    sendSuccess(res, result, "Signed agreement retrieved successfully");
  };

  getAgreementSignedDocument = async (req: Request, res: Response) => {
    const result = await this.svc.getAgreementSignedDocument(
      req.params.token as string,
    );
    sendSuccess(res, result, "Signed agreement retrieved successfully");
  };

  markFeeAgreementReceived = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.markFeeAgreementReceived(
      req.params.agreementId as string,
      organizationId!,
      staffId,
    );
    sendSuccess(res, result, "Fee agreement marked as received");
  };

  markFeeAgreementPaymentReceived = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.markFeeAgreementPaymentReceived(
      req.params.agreementId as string,
      organizationId!,
      staffId,
    );
    res.json({ success: true, data: result });
  };

  discardDraftFeeAgreement = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const result = await this.svc.discardDraftFeeAgreement(
      req.params.agreementId as string,
      organizationId!,
    );
    res.json({ success: true, data: result });
  };

  // Embedded signing session (public, token-gated)

  getEmbeddedSignSession = async (req: Request, res: Response) => {

    const result = await this.svc.getEmbeddedSignSession(
      req.params.token as string,
    );
    sendSuccess(res, result, "Signing session retrieved successfully");
  };

  getAgreementPaymentSession = async (req: Request, res: Response) => {
    const result = await this.svc.getAgreementPaymentSession(
      req.params.token as string,
    );
    sendSuccess(res, result, "Payment session retrieved successfully");
  };

  // Dropbox Sign Webhook (public)

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

  // Case Opening

  getEligibleTeamsForLead = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const teams = await this.svc.getEligibleTeamsForLead(
      req.params.id as string,
      organizationId!,
    );
    sendSuccess(res, teams, "Eligible teams retrieved");
  };

  openCase = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const result = await this.svc.openCase(
      req.params.id as string,
      organizationId!,
      req.body,
      staffId!,
    );
    sendSuccess(res, result, "Case opened successfully", 201);
  };

  // Case Workflow Steps

  getCaseWorkflowSteps = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const steps = await this.svc.getCaseWorkflowSteps(
      req.params.caseId as string,
      organizationId!,
    );
    sendSuccess(res, steps, "Workflow steps retrieved successfully");
  };

  updateCaseWorkflowStep = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const step = await this.svc.updateCaseWorkflowStep(
      req.params.caseId as string,
      req.params.stepId as string,
      organizationId!,
      req.body,
    );
    sendSuccess(res, step, "Workflow step updated successfully");
  };

  // Adverse Parties

  getAdverseParties = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const parties = await this.svc.getAdverseParties(
      req.params.caseId as string,
      organizationId!,
    );
    sendSuccess(res, parties, "Adverse parties retrieved successfully");
  };

  addAdverseParty = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const party = await this.svc.addAdverseParty(
      req.params.caseId as string,
      organizationId!,
      req.body,
    );
    sendSuccess(res, party, "Adverse party added successfully", 201);
  };

  updateAdverseParty = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const party = await this.svc.updateAdverseParty(
      req.params.caseId as string,
      req.params.partyId as string,
      organizationId!,
      req.body,
    );
    sendSuccess(res, party, "Adverse party updated successfully");
  };

  deleteAdverseParty = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    await this.svc.deleteAdverseParty(
      req.params.caseId as string,
      req.params.partyId as string,
      organizationId!,
    );
    sendSuccess(res, null, "Adverse party deleted successfully");
  };

  // Intake checklist — the firm-editable template new leads are stamped from.

  getIntakePipelineTemplate = async (_req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const template = await getIntakePipelineTemplate(organizationId!);
    sendSuccess(res, template, "Intake checklist retrieved successfully");
  };

  saveIntakePipelineSteps = async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const template = await saveIntakePipelineSteps(
      organizationId!,
      req.body.steps,
      staffId ?? null,
    );
    sendSuccess(res, template, "Intake checklist saved successfully");
  };

  initializePipeline = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const steps = await this.wfSvc.initializePipelineSteps(
      req.params.leadId as string,
      organizationId!,
    );
    sendSuccess(res, steps, "Pipeline steps initialized successfully");
  };

  // Everything that happens to an individual intake step now lives on
  // `/tasks/:id/*` — see tasks.routes.ts. Only the two lead-level list views
  // remain here, because both join the lead so a person can read the rows.

  // Lead Timeline

  getLeadTimeline = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const { page, limit } = parsePaginationQuery(req.query);
    const result = await this.svc.getLeadTimeline(
      req.params.leadId as string,
      organizationId!,
      page,
      limit,
    );
    logLeadView(
      organizationId!,
      req.params.leadId as string,
      staffId,
      "timeline",
    ).catch(() => {});
    sendSuccess(
      res,
      result.data,
      "Timeline events retrieved successfully",
      200,
      {
        pagination: result.pagination,
      },
    );
  };

  getLeadAuditLog = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const { page, limit } = parsePaginationQuery(req.query);
    const result = await this.svc.getLeadAuditLog(
      req.params.leadId as string,
      organizationId!,
      page,
      limit,
    );
    logLeadView(
      organizationId!,
      req.params.leadId as string,
      staffId,
      "audit-log",
    ).catch(() => {});
    sendSuccess(res, result.data, "Audit log retrieved successfully", 200, {
      pagination: result.pagination,
    });
  };

  // Lead Documents

  getLeadDocuments = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const docs = await this.wfSvc.getLinkedDocuments(
      req.params.leadId as string,
      organizationId!,
    );
    logLeadView(
      organizationId!,
      req.params.leadId as string,
      staffId,
      "documents",
    ).catch(() => {});
    sendSuccess(res, docs, "Linked documents retrieved successfully");
  };

  linkLeadDocument = async (req: Request, res: Response) => {
    const { staffId: _staffId, organizationId } = getRequestContext();
    const staffId = _staffId ?? undefined;
    const link = await this.wfSvc.linkDocument(
      req.body.documentId,
      req.params.leadId as string,
      staffId,
      organizationId!,
    );
    sendSuccess(res, link, "Document linked successfully", 201);
  };

  unlinkLeadDocument = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    await this.wfSvc.unlinkDocument(
      req.params.linkId as string,
      req.params.leadId as string,
      organizationId!,
    );
    sendSuccess(res, null, "Document unlinked successfully");
  };
}
