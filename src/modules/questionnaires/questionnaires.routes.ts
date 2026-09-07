import { Router } from "express";
import { documentUpload, type Upload } from "../../middleware/upload";

import { requireAuth } from "../../middleware/auth.middleware";
import { preserveRequestContext } from "../../middleware/request-context";
import { resolveActorContext } from "../../middleware/resolve-actor-context";

import { requirePermission } from "../../middleware/permission.middleware";
import { requirePlatformAdmin } from "../../middleware/require-platform-admin";

import { validateRequest } from "../../middleware/validate.middleware";
import { QuestionnairesController } from "./questionnaires.controller";
import { QuestionnairesValidation } from "./questionnaires.validation";

export class QuestionnairesRouter {
  public router: Router;
  public path: string;
  private questionnairesController: QuestionnairesController;
  private questionnairesValidation: QuestionnairesValidation;
  private upload: Upload;

  constructor(
    questionnairesController: QuestionnairesController,
    questionnairesValidation: QuestionnairesValidation,
  ) {
    this.router = Router();
    this.path = "/questionnaires";
    this.questionnairesController = questionnairesController;
    this.questionnairesValidation = questionnairesValidation;
    this.upload = documentUpload();

    this.initializeRoutes();
  }

  private initializeRoutes() {
    const ctrl = this.questionnairesController;
    const v = this.questionnairesValidation;

    // Public token-based client endpoints
    this.router.get(
      "/client/:token",
      validateRequest({ params: v.questionnaireClientTokenParamsSchema }),
      ctrl.getClientQuestionnaire,
    );
    this.router.put(
      "/client/:token/draft",
      validateRequest({ params: v.questionnaireClientTokenParamsSchema, body: v.responseBodySchema }),
      ctrl.saveDraftResponse,
    );
    this.router.post(
      "/client/:token/submit",
      validateRequest({ params: v.questionnaireClientTokenParamsSchema, body: v.responseBodySchema }),
      ctrl.submitResponse,
    );
    this.router.post(
      "/client/:token/files",
      preserveRequestContext(this.upload.single("file")),
      validateRequest({
        params: v.questionnaireClientTokenParamsSchema,
        body: v.uploadResponseFileBodySchema,
      }),
      ctrl.uploadResponseFile,
    );

    // Authenticated staff-or-admin intake routes
    // Send-wizard data, response review, accept, and manual reminders are usable
    // by firm staff (attorney/paralegal), not just org admins.
    const staffGuards = [requireAuth, resolveActorContext];

    this.router.get("/eligible-leads", ...staffGuards, ctrl.getEligibleLeads);
    this.router.get("/question-bank", ...staffGuards, ctrl.getQuestionBank);
    this.router.get(
      "/intake/case-type/:caseTypeId",
      ...staffGuards,
      validateRequest({ params: v.caseTypeIdParamsSchema }),
      ctrl.getCaseTypePreview,
    );
    this.router.get(
      "/responses/:responseId/detail",
      ...staffGuards,
      validateRequest({ params: v.responseIdParamsSchema }),
      ctrl.getResponseDetail,
    );
    this.router.post(
      "/responses/:responseId/accept",
      ...staffGuards,
      validateRequest({ params: v.responseIdParamsSchema }),
      ctrl.acceptResponse,
    );
    this.router.post(
      "/sends/:sendId/remind",
      ...staffGuards,
      validateRequest({ params: v.sendIdParamsSchema }),
      ctrl.sendReminder,
    );
    this.router.post(
      "/sends/:sendId/request-documents",
      ...staffGuards,
      validateRequest({ params: v.sendIdParamsSchema }),
      ctrl.requestMissingDocuments,
    );

    // Staff manual upload of a document received outside the client portal.
    this.router.post(
      "/responses/:responseId/files",
      ...staffGuards,
      preserveRequestContext(this.upload.single("file")),
      validateRequest({
        params: v.responseIdParamsSchema,
        body: v.uploadResponseFileStaffBodySchema,
      }),
      ctrl.uploadResponseFileForStaff,
    );

    // Response answers PDF available to any staff (documents excluded).
    this.router.get(
      "/responses/:responseId/pdf",
      ...staffGuards,
      validateRequest({ params: v.responseIdParamsSchema }),
      ctrl.downloadResponsePdf,
    );

    // Individual uploaded document gated by the documents:download permission.
    this.router.get(
      "/files/:fileId/download",
      ...staffGuards,
      requirePermission("documents", "download"),
      validateRequest({ params: v.fileIdParamsSchema }),
      ctrl.downloadResponseFile,
    );

    // Get all questionnaire files for a lead
    this.router.get(
      "/leads/:leadId/documents",
      ...staffGuards,
      ctrl.getFilesByLeadId,
    );

    // Authenticated admin routes
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /*
      What a question can be wired to — the same list for both tiers.

      Two routes rather than one because the guards are what differ: a firm
      admin names its own questions, an operator names Oravanti's, and both
      choose from the one form catalogue. Registered before `/system/:id`,
      which would otherwise match `/system/field-vocabulary` and go looking for
      a questionnaire by that id.
    */
    this.router.get(
      "/field-vocabulary",
      requirePermission("workflow", "read"),
      ctrl.getFieldVocabulary,
    );
    this.router.get(
      "/system/field-vocabulary",
      requirePlatformAdmin,
      ctrl.getFieldVocabulary,
    );

    /*
      System questionnaire management — the platform's backbone.
      
      These five write `scope: "system"` rows with a NULL `organization_id`,
      which every firm in the deployment reads. They were commented "platform
      admin" and gated on nothing but `requireAuth`: the service docblock
      claimed an authority the app could not check. RLS stopped the insert
      (a tenant connection cannot write a NULL org), so the practical result
      was a 500 rather than a breach — but the guard is the thing that should
      have said so.
      
      `requirePlatformAdmin` per route rather than mounted, because this router
      serves firm staff and clients on every other path. It is the one place in
      the codebase where a per-route guard is the right shape.
    */
    this.router.get("/system", requirePlatformAdmin, ctrl.getSystemQuestionnaires);
    this.router.post(
      "/system",
      requirePlatformAdmin,
      validateRequest({ body: v.createSystemQuestionnaireBodySchema }),
      ctrl.createSystemQuestionnaire,
    );
    this.router.get(
      "/system/:id",
      requirePlatformAdmin,
      validateRequest({ params: v.systemQuestionnaireIdParamsSchema }),
      ctrl.getSystemQuestionnaireById,
    );
    this.router.post(
      "/system/:id/sections",
      requirePlatformAdmin,
      validateRequest({ params: v.systemQuestionnaireIdParamsSchema, body: v.addSectionBodySchema }),
      ctrl.addSystemSection,
    );
    this.router.post(
      "/system/:id/sections/:sectionId/questions",
      requirePlatformAdmin,
      validateRequest({ params: v.systemSectionParamsSchema }),
      ctrl.addSystemQuestion,
    );

    /*
      Editing and removing the backbone.

      The firm-facing `/sections/:sectionId` and `/questions/:questionId` below
      cannot reach these rows — they match on the caller's `organizationId`,
      and a platform row carries none — so the two tiers need separate routes
      even though the tables are shared. That asymmetry is the ownership rule
      made routable: a firm edits what it wrote, Oravanti edits what it
      published, and neither pair of routes can be pointed at the other's rows.

      Nested under the questionnaire they belong to rather than addressed by
      bare id, because a platform admin holds no tenant scope at all — the path
      is the only thing left saying which questionnaire is being changed, and a
      reader of the audit trail deserves to see it.
    */
    this.router.patch(
      "/system/:id",
      requirePlatformAdmin,
      validateRequest({
        params: v.systemQuestionnaireIdParamsSchema,
        body: v.updateSystemQuestionnaireBodySchema,
      }),
      ctrl.updateSystemQuestionnaire,
    );
    this.router.patch(
      "/system/:id/sections/:sectionId",
      requirePlatformAdmin,
      validateRequest({
        params: v.systemSectionParamsSchema,
        body: v.updateSectionBodySchema,
      }),
      ctrl.updateSystemSection,
    );
    this.router.delete(
      "/system/:id/sections/:sectionId",
      requirePlatformAdmin,
      validateRequest({ params: v.systemSectionParamsSchema }),
      ctrl.deleteSystemSection,
    );
    this.router.patch(
      "/system/:id/sections/:sectionId/questions/:questionId",
      requirePlatformAdmin,
      validateRequest({
        params: v.systemQuestionParamsSchema,
        body: v.updateQuestionBodySchema,
      }),
      ctrl.updateSystemQuestion,
    );
    this.router.delete(
      "/system/:id/sections/:sectionId/questions/:questionId",
      requirePlatformAdmin,
      validateRequest({ params: v.systemQuestionParamsSchema }),
      ctrl.deleteSystemQuestion,
    );

    // Firm additions — apply to every matter of this case type.
    this.router.get(
      "/case-type/:caseTypeId",
      validateRequest({ params: v.caseTypeIdParamsSchema, query: v.stageQuerySchema }),
      ctrl.getMergedQuestionnaire,
    );
    this.router.get(
      "/case-type/:caseTypeId/system",
      validateRequest({ params: v.caseTypeIdParamsSchema }),
      ctrl.getSystemQuestionnaireByCaseType,
    );
    this.router.post(
      "/case-type/:caseTypeId/sections",
      validateRequest({ params: v.caseTypeIdParamsSchema, body: v.addSectionBodySchema }),
      ctrl.addSection,
    );
    this.router.post(
      "/case-type/:caseTypeId/questions",
      validateRequest({ params: v.caseTypeIdParamsSchema, body: v.addQuestionBodySchema }),
      ctrl.addQuestion,
    );

    // Per-matter additions — the same handlers, reached by a route that names a
    // case instead of a case type. That path, not the body, is what makes the
    // write case-scoped.
    this.router.get(
      "/case/:caseId",
      validateRequest({ params: v.caseIdParamsSchema }),
      ctrl.getCaseQuestionnaire,
    );
    this.router.post(
      "/case/:caseId/sections",
      validateRequest({ params: v.caseIdParamsSchema, body: v.addSectionBodySchema }),
      ctrl.addSection,
    );
    this.router.post(
      "/case/:caseId/questions",
      validateRequest({ params: v.caseIdParamsSchema, body: v.addQuestionBodySchema }),
      ctrl.addQuestion,
    );

    // Read-only: the intake answers the matter came from. Kept as history, not
    // reopened for editing — see the service.
    this.router.get(
      "/case/:caseId/intake",
      validateRequest({ params: v.caseIdParamsSchema }),
      ctrl.getIntakeResponseForCase,
    );

    // The matter's own answers. One response per matter whichever way it was
    // filled, so staff typing on a call and a client answering a link write
    // the same row rather than two half-answered copies.
    this.router.get(
      "/case/:caseId/response",
      validateRequest({ params: v.caseIdParamsSchema }),
      ctrl.getCaseResponse,
    );
    this.router.put(
      "/case/:caseId/answers",
      validateRequest({
        params: v.caseIdParamsSchema,
        body: v.saveCaseAnswersBodySchema,
      }),
      ctrl.saveCaseAnswers,
    );

    // Sending is delivery, not authorship: the questionnaire is already what
    // it is, so this only chooses which of its sections the client sees.
    this.router.post(
      "/case/:caseId/send",
      validateRequest({
        params: v.caseIdParamsSchema,
        body: v.sendCaseQuestionnaireBodySchema,
      }),
      ctrl.sendCaseQuestionnaire,
    );

    // Answer history. Every one of these hangs off the matter, so opening the
    // matter is the only permission question — an id alone opens nothing.
    this.router.get(
      "/case/:caseId/versions",
      validateRequest({ params: v.caseIdParamsSchema }),
      ctrl.getCaseVersions,
    );
    this.router.get(
      "/case/:caseId/versions/:versionId",
      validateRequest({ params: v.caseVersionParamsSchema }),
      ctrl.getCaseVersion,
    );
    this.router.get(
      "/case/:caseId/questions/:questionId/history",
      validateRequest({ params: v.caseQuestionParamsSchema }),
      ctrl.getAnswerHistory,
    );

    // Restores are POSTs, not PUTs: each one writes a new version rather than
    // putting the response back to a previous state, so repeating it is not the
    // same as doing it once.
    this.router.post(
      "/case/:caseId/versions/:versionId/restore",
      validateRequest({ params: v.caseVersionParamsSchema }),
      ctrl.restoreVersion,
    );
    this.router.post(
      "/case/:caseId/revisions/:revisionId/restore",
      validateRequest({ params: v.caseRevisionParamsSchema }),
      ctrl.restoreAnswer,
    );

    // Editing and deletion address the row by id and match on the owning org,
    // so one pair of routes covers both tiers — and neither can reach a
    // platform-owned row, whose organization_id is null.
    this.router.patch(
      "/sections/:sectionId",
      validateRequest({ params: v.sectionParamsSchema, body: v.addSectionBodySchema }),
      ctrl.updateSection,
    );
    this.router.delete(
      "/sections/:sectionId",
      validateRequest({ params: v.sectionParamsSchema }),
      ctrl.deleteSection,
    );
    this.router.patch(
      "/questions/:questionId",
      validateRequest({ params: v.questionParamsSchema, body: v.updateQuestionBodySchema }),
      ctrl.updateQuestion,
    );
    this.router.delete(
      "/questions/:questionId",
      validateRequest({ params: v.questionParamsSchema }),
      ctrl.deleteQuestion,
    );

    // Case-eligible questionnaire
    this.router.get(
      "/eligible-for-case/:caseId",
      validateRequest({ params: v.eligibleForCaseParamsSchema }),
      ctrl.getEligibleQuestionnairesForCase,
    );

    // Responses
    this.router.get(
      "/:id/responses",
      validateRequest({ params: v.questionnaireIdParamsSchema, query: v.listResponsesQuerySchema }),
      ctrl.getResponses,
    );
  }
}
