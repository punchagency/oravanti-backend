import { Router } from "express";
import multer from "multer";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { LeadsController } from "./leads.controller";
import * as v from "./leads.validation";

// ── Lead Workflow router ─────────────────────────────────────────────────────

export class LeadWorkflowRouter {
  public router: Router;
  public path: string;
  private ctrl: LeadsController;

  constructor(ctrl: LeadsController) {
    this.router = Router();
    this.path = "/leads";
    this.ctrl = ctrl;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { ctrl } = this;

    // ── My Tasks (must be before /:leadId routes) ──────────────────────────

    this.router.get(
      "/my-tasks",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      ctrl.getMyLeadTasks,
    );

    // ── Review Queue (must be before /:leadId routes) ──────────────────────

    this.router.get(
      "/review-queue",
      requireAuth,
      requireAdmin,
      setFirmContext,
      ctrl.getLeadReviewQueue,
    );

    // ── Tasks ──────────────────────────────────────────────────────────────

    this.router.post(
      "/:leadId/initialize-pipeline",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.leadIdParamsSchema }),
      ctrl.initializePipeline,
    );

    this.router.get(
      "/:leadId/tasks",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.leadIdParamsSchema }),
      ctrl.getLeadTasks,
    );

    this.router.post(
      "/:leadId/tasks",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadIdParamsSchema,
        body: v.createLeadTaskBodySchema,
      }),
      ctrl.createLeadTask,
    );

    this.router.patch(
      "/:leadId/tasks/:taskId",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadTaskIdParamsSchema,
        body: v.updateLeadTaskBodySchema,
      }),
      ctrl.updateLeadTask,
    );

    this.router.patch(
      "/:leadId/tasks/:taskId/status",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadTaskIdParamsSchema,
        body: v.updateLeadTaskStatusBodySchema,
      }),
      ctrl.updateLeadTaskStatus,
    );

    this.router.patch(
      "/:leadId/tasks/:taskId/assign",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadTaskIdParamsSchema,
        body: v.assignLeadTaskBodySchema,
      }),
      ctrl.assignLeadTask,
    );

    this.router.post(
      "/:leadId/tasks/:taskId/complete",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.leadTaskIdParamsSchema }),
      ctrl.completeLeadTask,
    );

    this.router.post(
      "/:leadId/tasks/:taskId/submit-review",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadTaskIdParamsSchema,
        body: v.submitReviewBodySchema,
      }),
      ctrl.submitLeadTaskForReview,
    );

    this.router.post(
      "/:leadId/tasks/:taskId/approve",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadTaskIdParamsSchema,
        body: v.reviewActionBodySchema,
      }),
      ctrl.approveLeadTask,
    );

    this.router.post(
      "/:leadId/tasks/:taskId/reject",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadTaskIdParamsSchema,
        body: v.rejectReviewBodySchema,
      }),
      ctrl.rejectLeadTask,
    );

    this.router.delete(
      "/:leadId/tasks/:taskId",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.leadTaskIdParamsSchema }),
      ctrl.deleteLeadTask,
    );

    // ── Timeline ───────────────────────────────────────────────────────────

    this.router.get(
      "/:leadId/timeline",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.leadIdParamsSchema }),
      ctrl.getLeadTimeline,
    );

    this.router.post(
      "/:leadId/timeline",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadIdParamsSchema,
        body: v.createTimelineEventBodySchema,
      }),
      ctrl.createLeadTimelineEvent,
    );

    // ── Documents ──────────────────────────────────────────────────────────

    this.router.get(
      "/:leadId/documents",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.leadIdParamsSchema }),
      ctrl.getLeadDocuments,
    );

    this.router.post(
      "/:leadId/documents",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadIdParamsSchema,
        body: v.linkDocumentBodySchema,
      }),
      ctrl.linkLeadDocument,
    );

    this.router.delete(
      "/:leadId/documents/:linkId",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      ctrl.unlinkLeadDocument,
    );

    // ── Notes ─────────────────────────────────────────────────────────────

    this.router.get(
      "/:leadId/notes",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.leadIdParamsSchema }),
      ctrl.getLeadNotes,
    );

    this.router.post(
      "/:leadId/notes",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadIdParamsSchema,
        body: v.createLeadNoteBodySchema,
      }),
      ctrl.createLeadNote,
    );

    this.router.patch(
      "/:leadId/notes/:noteId",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.leadNoteIdParamsSchema,
        body: v.updateLeadNoteBodySchema,
      }),
      ctrl.updateLeadNote,
    );

    this.router.delete(
      "/:leadId/notes/:noteId",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.leadNoteIdParamsSchema }),
      ctrl.deleteLeadNote,
    );
  }
}

export class LeadsRouter {
  public router: Router;
  public path: string;
  private ctrl: LeadsController;

  constructor(ctrl: LeadsController) {
    this.router = Router();
    this.path = "/leads";
    this.ctrl = ctrl;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { ctrl } = this;

    // ── Leads CRUD ────────────────────────────────────────────────────────────

    this.router.post(
      "/",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ body: v.createLeadBodySchema }),
      ctrl.createLead,
    );

    this.router.get(
      "/",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      ctrl.getAllLeads,
    );

    this.router.get(
      "/stage-counts",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      ctrl.getLeadStageCounts,
    );

    // Registered before "/:id" so "/consultations" isn't captured as an id.
    this.router.get(
      "/consultations",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      ctrl.getConsultations,
    );

    this.router.get(
      "/:id",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getLeadById,
    );

    this.router.patch(
      "/:id",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.idParamsSchema,
        body: v.updateLeadBodySchema,
      }),
      ctrl.updateLead,
    );

    this.router.patch(
      "/:id/stage",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.idParamsSchema,
        body: v.advanceStageBodySchema,
      }),
      ctrl.advanceLeadStage,
    );

    this.router.patch(
      "/:id/status",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.idParamsSchema,
        body: v.updateLeadStatusSchema,
      }),
      ctrl.updateLeadStatus,
    );

    // ── Conflict Check ────────────────────────────────────────────────────────

    this.router.post(
      "/:id/check-conflict",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.runConflictCheck,
    );

    this.router.get(
      "/:id/conflict-check",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getConflictCheck,
    );

    this.router.patch(
      "/:id/conflict-check",
      requireAuth,
      requireStaffOrAdmin, // populates req.staffId (audit actor)
      requirePermission("conflicts", "review"), // owner/admin gate (real enforcement)
      setFirmContext,
      validateRequest({
        params: v.idParamsSchema,
        body: v.resolveConflictCheckBodySchema,
      }),
      ctrl.resolveConflictCheck,
    );

    // ── Questionnaire ─────────────────────────────────────────────────────────

    this.router.post(
      "/:id/send-questionnaire",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.idParamsSchema,
        body: v.sendQuestionnaireBodySchema,
      }),
      ctrl.sendQuestionnaire,
    );

    this.router.get(
      "/:id/questionnaire",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getLeadQuestionnaire,
    );

    // ── Consultation ──────────────────────────────────────────────────────────

    this.router.post(
      "/:id/consultation",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.idParamsSchema,
        body: v.initiateConsultationBodySchema,
      }),
      ctrl.initiateConsultation,
    );

    this.router.get(
      "/:id/consultation",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getConsultation,
    );

    this.router.patch(
      "/:id/consultation",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.idParamsSchema,
        body: v.updateConsultationBodySchema,
      }),
      ctrl.updateConsultation,
    );

    this.router.post(
      "/:id/consultation/cancel",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.idParamsSchema,
        body: v.cancelConsultationBodySchema,
      }),
      ctrl.cancelConsultation,
    );

    // ── Fee Agreement ─────────────────────────────────────────────────────────

    this.router.post(
      "/:id/generate-agreement",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.idParamsSchema,
        body: v.generateFeeAgreementBodySchema,
      }),
      ctrl.generateFeeAgreement,
    );

    this.router.get(
      "/:id/agreement",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getFeeAgreement,
    );

    // ── Case Opening ──────────────────────────────────────────────────────────

    this.router.get(
      "/:id/eligible-teams",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getEligibleTeamsForLead,
    );

    this.router.post(
      "/:id/open-case",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ params: v.idParamsSchema, body: v.openCaseBodySchema }),
      ctrl.openCase,
    );
  }
}

// ── Agreements router (nudge endpoint lives at /agreements/:agreementId) ──────

export class AgreementsRouter {
  public router: Router;
  public path: string;
  private ctrl: LeadsController;

  constructor(ctrl: LeadsController) {
    this.router = Router();
    this.path = "/agreements";
    this.ctrl = ctrl;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { ctrl } = this;

    this.router.get(
      "/:agreementId/preview",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.getFeeAgreementPreview,
    );

    this.router.post(
      "/:agreementId/nudge-client",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.nudgeClient,
    );

    this.router.post(
      "/:agreementId/send",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.sendFeeAgreement,
    );

    this.router.post(
      "/:agreementId/mark-received",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.markFeeAgreementReceived,
    );

    this.router.post(
      "/:agreementId/mark-payment-received",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.markFeeAgreementPaymentReceived,
    );

    this.router.post(
      "/:agreementId/discard",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.discardDraftFeeAgreement,
    );
  }
}

// ── Webhook router (public, no auth) ─────────────────────────────────────────

export class WebhooksRouter {
  public router: Router;
  public path: string;
  private ctrl: LeadsController;
  // Dropbox Sign posts multipart/form-data with a single `json` field and no
  // files; memory storage + .none() parses that text field onto req.body.
  private upload = multer({ storage: multer.memoryStorage() });

  constructor(ctrl: LeadsController) {
    this.router = Router();
    this.path = "/webhooks";
    this.ctrl = ctrl;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { ctrl } = this;

    this.router.post(
      "/dropbox-sign",
      this.upload.none(),
      ctrl.handleDropboxSignWebhook,
    );
  }
}

// ── Agreement signing router (public, token-gated client signing page) ───────

export class AgreementSigningRouter {
  public router: Router;
  public path: string;
  private ctrl: LeadsController;

  constructor(ctrl: LeadsController) {
    this.router = Router();
    this.path = "/agreement-signing";
    this.ctrl = ctrl;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { ctrl } = this;

    this.router.post(
      "/:token/session",
      validateRequest({ params: v.agreementSigningTokenParamsSchema }),
      ctrl.getEmbeddedSignSession,
    );
  }
}

// Public, token-gated lead-facing consultation booking at /consultation-booking.
export class ConsultationBookingRouter {
  public router: Router;
  public path: string;
  private ctrl: LeadsController;

  constructor(ctrl: LeadsController) {
    this.router = Router();
    this.path = "/consultation-booking";
    this.ctrl = ctrl;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { ctrl } = this;

    this.router.get(
      "/:token",
      validateRequest({ params: v.bookingTokenParamsSchema }),
      ctrl.getConsultationBooking,
    );

    this.router.post(
      "/:token/pay",
      validateRequest({ params: v.bookingTokenParamsSchema }),
      ctrl.payConsultationFee,
    );

    this.router.post(
      "/:token/select-slot",
      validateRequest({
        params: v.bookingTokenParamsSchema,
        body: v.selectSlotBodySchema,
      }),
      ctrl.selectConsultationSlot,
    );

    this.router.patch(
      "/:token/timezone",
      validateRequest({
        params: v.bookingTokenParamsSchema,
        body: v.updateBookingTimezoneBodySchema,
      }),
      ctrl.updateBookingTimezone,
    );
  }
}

// ── Case sub-resource routers (workflow + adverse parties) ────────────────────

export class CaseWorkflowRouter {
  public router: Router;
  public path: string;
  private ctrl: LeadsController;

  constructor(ctrl: LeadsController) {
    this.router = Router();
    this.path = "/cases";
    this.ctrl = ctrl;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { ctrl } = this;

    this.router.get(
      "/:caseId/workflow",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.caseIdParamsSchema }),
      ctrl.getCaseWorkflowSteps,
    );

    this.router.patch(
      "/:caseId/workflow/:stepId",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.caseIdStepIdParamsSchema,
        body: v.updateWorkflowStepBodySchema,
      }),
      ctrl.updateCaseWorkflowStep,
    );

    this.router.get(
      "/:caseId/adverse-parties",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.caseIdParamsSchema }),
      ctrl.getAdverseParties,
    );

    this.router.post(
      "/:caseId/adverse-parties",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.caseIdParamsSchema,
        body: v.addAdversePartyBodySchema,
      }),
      ctrl.addAdverseParty,
    );

    this.router.patch(
      "/:caseId/adverse-parties/:partyId",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({
        params: v.adversePartyParamsSchema,
        body: v.updateAdversePartyBodySchema,
      }),
      ctrl.updateAdverseParty,
    );

    this.router.delete(
      "/:caseId/adverse-parties/:partyId",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ params: v.adversePartyParamsSchema }),
      ctrl.deleteAdverseParty,
    );
  }
}
