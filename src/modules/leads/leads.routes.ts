import { Router } from "express";
import { fieldsOnlyUpload } from "../../middleware/upload";

import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { requirePermission } from "../../middleware/permission.middleware";


import { validateRequest } from "../../middleware/validate.middleware";
import { LeadsController } from "./leads.controller";
import * as v from "./leads.validation";

// Lead Workflow router

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

    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // Both cross-lead lists moved to /tasks:
    //   GET /tasks/my-tasks?source=pipeline
    //   GET /tasks/review-queue?source=pipeline
    // One pair of endpoints serves intake steps and case workflow steps from the
    // one table, in one row shape.

    // Intake checklist — the firm-editable template every new lead is stamped
    // from. Static paths, so they must be declared before the /:leadId routes.
    // Gated on `workflow` rather than `leads`: this is the intake twin of the
    // case workflow template editor, and editing it changes every future lead.

    this.router.get(
      "/intake-pipeline/template",
      requirePermission("workflow", "read"),
      ctrl.getIntakePipelineTemplate,
    );

    this.router.put(
      "/intake-pipeline/template/steps",
      requirePermission("workflow", "update"),
      validateRequest({ body: v.saveIntakePipelineStepsSchema }),
      ctrl.saveIntakePipelineSteps,
    );

    // Pipeline
    //
    // Stamping a lead with the firm's checklist is a lead-level operation, so it
    // lives here. Everything that happens to an individual step afterwards —
    // reading, assigning, completing, the whole review loop — is on `/tasks`,
    // which serves intake steps, case workflow steps and ad-hoc to-dos from the
    // one table they all live in. There is no lead-scoped task surface.

    this.router.post(
      "/:leadId/initialize-pipeline",
      requireAuth,
      validateRequest({ params: v.leadIdParamsSchema }),
      ctrl.initializePipeline,
    );

    // Timeline

    this.router.get(
      "/:leadId/timeline",
      requireAuth,
      validateRequest({ params: v.leadIdParamsSchema, query: v.paginationQuerySchema }),
      ctrl.getLeadTimeline,
    );

    this.router.get(
      "/:leadId/audit-log",
      requireAuth,
      validateRequest({ params: v.leadIdParamsSchema, query: v.paginationQuerySchema }),
      ctrl.getLeadAuditLog,
    );

    // Documents

    this.router.get(
      "/:leadId/documents",
      requireAuth,
      validateRequest({ params: v.leadIdParamsSchema }),
      ctrl.getLeadDocuments,
    );

    this.router.post(
      "/:leadId/documents",
      requireAuth,
      validateRequest({
        params: v.leadIdParamsSchema,
        body: v.linkDocumentBodySchema,
      }),
      ctrl.linkLeadDocument,
    );

    this.router.delete(
      "/:leadId/documents/:linkId",
      requireAuth,
      validateRequest({ params: v.leadDocumentLinkIdParamsSchema }),
      ctrl.unlinkLeadDocument,
    );

    // Notes

    this.router.get(
      "/:leadId/notes",
      requireAuth,
      validateRequest({ params: v.leadIdParamsSchema }),
      ctrl.getLeadNotes,
    );

    this.router.post(
      "/:leadId/notes",
      requireAuth,
      validateRequest({
        params: v.leadIdParamsSchema,
        body: v.createLeadNoteBodySchema,
      }),
      ctrl.createLeadNote,
    );

    this.router.patch(
      "/:leadId/notes/:noteId",
      requireAuth,
      validateRequest({
        params: v.leadNoteIdParamsSchema,
        body: v.updateLeadNoteBodySchema,
      }),
      ctrl.updateLeadNote,
    );

    this.router.delete(
      "/:leadId/notes/:noteId",
      requireAuth,
      validateRequest({ params: v.leadNoteIdParamsSchema }),
      ctrl.deleteLeadNote,
    );

    // Bulk operations

    this.router.post(
      "/:leadId/notes/bulk-delete",
      requireAuth,
      validateRequest({ params: v.leadIdParamsSchema, body: v.bulkDeleteNotesBodySchema }),
      ctrl.bulkDeleteNotes,
    );

    this.router.post(
      "/:leadId/notes/bulk-pin",
      requireAuth,
      validateRequest({ params: v.leadIdParamsSchema, body: v.bulkPinNotesBodySchema }),
      ctrl.bulkPinNotes,
    );

    this.router.post(
      "/:leadId/notes/:noteId/toggle-pin",
      requireAuth,
      validateRequest({ params: v.leadNoteIdParamsSchema }),
      ctrl.toggleNotePin,
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

    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // Leads CRUD

    this.router.post(
      "/",
      requireAuth,
      validateRequest({ body: v.createLeadBodySchema }),
      ctrl.createLead,
    );

    this.router.get(
      "/",
      requireAuth,
      ctrl.getAllLeads,
    );

    this.router.get(
      "/stage-counts",
      requireAuth,
      ctrl.getLeadStageCounts,
    );

    // Registered before "/:id" so "/metrics" isn't captured as an id.
    this.router.get(
      "/metrics",
      requireAuth,
      validateRequest({ query: v.leadMetricsQuerySchema }),
      ctrl.getLeadMetrics,
    );

    // Registered before "/:id" so "/consultations" isn't captured as an id.
    this.router.get(
      "/consultations",
      requireAuth,
      ctrl.getConsultations,
    );

    this.router.get(
      "/:id",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getLeadById,
    );

    this.router.patch(
      "/:id",
      requireAuth,
      validateRequest({
        params: v.idParamsSchema,
        body: v.updateLeadBodySchema,
      }),
      ctrl.updateLead,
    );

    this.router.patch(
      "/:id/stage",
      requireAuth,
      validateRequest({
        params: v.idParamsSchema,
        body: v.advanceStageBodySchema,
      }),
      ctrl.advanceLeadStage,
    );

    this.router.patch(
      "/:id/status",
      requireAuth,
      validateRequest({
        params: v.idParamsSchema,
        body: v.updateLeadStatusSchema,
      }),
      ctrl.updateLeadStatus,
    );

    // Activity trail (read-only; events are append-only by design)

    this.router.get(
      "/:id/activity",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getLeadActivity,
    );

    // Archive / restore

    this.router.post(
      "/:id/archive",
      requireAuth,
      validateRequest({
        params: v.idParamsSchema,
        body: v.archiveLeadBodySchema,
      }),
      ctrl.archiveLead,
    );

    this.router.post(
      "/:id/restore",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.restoreLead,
    );

    // Conflict Check

    this.router.post(
      "/:id/check-conflict",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.runConflictCheck,
    );

    this.router.get(
      "/:id/layout",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getLeadLayout,
    );

    this.router.get(
      "/:id/conflict-check",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getConflictCheck,
    );

    this.router.patch(
      "/:id/conflict-check",
      requireAuth,      requirePermission("conflicts", "review"), // owner/admin gate (real enforcement)
      validateRequest({
        params: v.idParamsSchema,
        body: v.resolveConflictCheckBodySchema,
      }),
      ctrl.resolveConflictCheck,
    );

    // Questionnaire

    this.router.post(
      "/:id/send-questionnaire",
      requireAuth,
      validateRequest({
        params: v.idParamsSchema,
        body: v.sendQuestionnaireBodySchema,
      }),
      ctrl.sendQuestionnaire,
    );

    this.router.get(
      "/:id/questionnaire",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getLeadQuestionnaire,
    );

    // Consultation
    //
    // Booking and editing a consultation advance the lead's pipeline stage and
    // write to the lead row, so they sit under `leads:update` rather than a
    // resource of their own. Reading stays open to anyone who can already see
    // the lead.
    //
    // This is not cosmetic: `POST /:id/consultation` is the route that sets the
    // fee. It carried `requireAuth` alone, so any authenticated member of the
    // firm could book a consultation at an arbitrary amount — and the
    // route-authorization ratchet could not see it, because `coverageOf` grades
    // per module and this file's two other `requirePermission` calls already
    // classified the whole module as partially gated.
    const mayUpdateLead = requirePermission({ leads: ["update"] });

    this.router.post(
      "/:id/consultation",
      requireAuth,
      mayUpdateLead,
      validateRequest({
        params: v.idParamsSchema,
        body: v.initiateConsultationBodySchema,
      }),
      ctrl.initiateConsultation,
    );

    this.router.get(
      "/:id/consultation",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getConsultation,
    );

    this.router.patch(
      "/:id/consultation",
      requireAuth,
      mayUpdateLead,
      validateRequest({
        params: v.idParamsSchema,
        body: v.updateConsultationBodySchema,
      }),
      ctrl.updateConsultation,
    );

    /**
     * Cancelling requires the permission to send money back.
     *
     * Cancelling and refunding used to come apart: anyone in intake could
     * cancel, and a cancellation by someone without `finance:refund` left the
     * money owed and raised a task for an administrator. That produced a dead
     * end — the task said "refund this" and the person holding it had nowhere
     * to do it.
     *
     * Keeping the two together means the refund is attempted by the same act
     * that creates the obligation, which is the only arrangement where the
     * client's money cannot be stranded by a permission boundary.
     */
    this.router.post(
      "/:id/consultation/cancel",
      requireAuth,
      requirePermission({ finance: ["refund"] }),
      validateRequest({
        params: v.idParamsSchema,
        body: v.cancelConsultationBodySchema,
      }),
      ctrl.cancelConsultation,
    );

    // Fee Agreement

    this.router.post(
      "/:id/generate-agreement",
      requireAuth,
      validateRequest({
        params: v.idParamsSchema,
        body: v.generateFeeAgreementBodySchema,
      }),
      ctrl.generateFeeAgreement,
    );

    this.router.get(
      "/:id/agreement",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getFeeAgreement,
    );

    // Case Opening

    this.router.get(
      "/:id/eligible-teams",
      requireAuth,
      validateRequest({ params: v.idParamsSchema }),
      ctrl.getEligibleTeamsForLead,
    );

    this.router.post(
      "/:id/open-case",
      requireAuth,
      validateRequest({ params: v.idParamsSchema, body: v.openCaseBodySchema }),
      ctrl.openCase,
    );
  }
}

// Agreements router (nudge endpoint lives at /agreements/:agreementId)

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

    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    this.router.get(
      "/:agreementId/preview",
      requireAuth,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.getFeeAgreementPreview,
    );

    this.router.post(
      "/:agreementId/nudge-client",
      requireAuth,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.nudgeClient,
    );

    this.router.post(
      "/:agreementId/send",
      requireAuth,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.sendFeeAgreement,
    );

    this.router.post(
      "/:agreementId/mark-received",
      requireAuth,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.markFeeAgreementReceived,
    );

    this.router.post(
      "/:agreementId/mark-payment-received",
      requireAuth,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.markFeeAgreementPaymentReceived,
    );

    this.router.post(
      "/:agreementId/discard",
      requireAuth,
      validateRequest({ params: v.agreementIdParamsSchema }),
      ctrl.discardDraftFeeAgreement,
    );
  }
}

// Webhook router (public, no auth)

export class WebhooksRouter {
  public router: Router;
  public path: string;
  private ctrl: LeadsController;
  // Dropbox Sign posts multipart/form-data with a single `json` field and no
  // files; memory storage + .none() parses that text field onto req.body.
  private upload = fieldsOnlyUpload();

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

// Agreement signing router (public, token-gated client signing page)

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
      ctrl.startConsultationPayment,
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

// Case sub-resource routers (workflow + adverse parties)

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

    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    this.router.get(
      "/:caseId/workflow",
      requireAuth,
      validateRequest({ params: v.caseIdParamsSchema }),
      ctrl.getCaseWorkflowSteps,
    );

    this.router.patch(
      "/:caseId/workflow/:stepId",
      requireAuth,
      validateRequest({
        params: v.caseIdStepIdParamsSchema,
        body: v.updateWorkflowStepBodySchema,
      }),
      ctrl.updateCaseWorkflowStep,
    );

    this.router.get(
      "/:caseId/adverse-parties",
      requireAuth,
      validateRequest({ params: v.caseIdParamsSchema }),
      ctrl.getAdverseParties,
    );

    this.router.post(
      "/:caseId/adverse-parties",
      requireAuth,
      validateRequest({
        params: v.caseIdParamsSchema,
        body: v.addAdversePartyBodySchema,
      }),
      ctrl.addAdverseParty,
    );

    this.router.patch(
      "/:caseId/adverse-parties/:partyId",
      requireAuth,
      validateRequest({
        params: v.adversePartyParamsSchema,
        body: v.updateAdversePartyBodySchema,
      }),
      ctrl.updateAdverseParty,
    );

    this.router.delete(
      "/:caseId/adverse-parties/:partyId",
      requireAuth,
      validateRequest({ params: v.adversePartyParamsSchema }),
      ctrl.deleteAdverseParty,
    );
  }
}
