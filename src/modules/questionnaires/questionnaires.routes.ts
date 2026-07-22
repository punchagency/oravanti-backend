import { Router } from "express";
import multer from "multer";

import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";

import { requirePermission } from "../../middleware/permission.middleware";

import { validateRequest } from "../../middleware/validate.middleware";
import { QuestionnairesController } from "./questionnaires.controller";
import { QuestionnairesValidation } from "./questionnaires.validation";

export class QuestionnairesRouter {
  public router: Router;
  public path: string;
  private questionnairesController: QuestionnairesController;
  private questionnairesValidation: QuestionnairesValidation;
  private upload: multer.Multer;

  constructor(
    questionnairesController: QuestionnairesController,
    questionnairesValidation: QuestionnairesValidation,
  ) {
    this.router = Router();
    this.path = "/questionnaires";
    this.questionnairesController = questionnairesController;
    this.questionnairesValidation = questionnairesValidation;
    this.upload = multer({ storage: multer.memoryStorage() });

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
      this.upload.single("file"),
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
      this.upload.single("file"),
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

    // System questionnaire management (platform admin)
    this.router.get("/system", ctrl.getSystemQuestionnaires);
    this.router.post(
      "/system",
      validateRequest({ body: v.createSystemQuestionnaireBodySchema }),
      ctrl.createSystemQuestionnaire,
    );
    this.router.get(
      "/system/:id",
      validateRequest({ params: v.systemQuestionnaireIdParamsSchema }),
      ctrl.getSystemQuestionnaireById,
    );
    this.router.post(
      "/system/:id/sections",
      validateRequest({ params: v.systemQuestionnaireIdParamsSchema, body: v.addSectionBodySchema }),
      ctrl.addSystemSection,
    );
    this.router.post(
      "/system/:id/sections/:sectionId/questions",
      validateRequest({ params: v.systemSectionParamsSchema }),
      ctrl.addSystemQuestion,
    );

    // Firm questionnaire additions (org-scoped merged view + CRUD)
    this.router.get(
      "/case-type/:caseTypeId",
      validateRequest({ params: v.caseTypeIdParamsSchema }),
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
      ctrl.addFirmSection,
    );
    this.router.patch(
      "/case-type/:caseTypeId/sections/:sectionId",
      validateRequest({ params: v.firmSectionParamsSchema, body: v.addSectionBodySchema }),
      ctrl.updateFirmSection,
    );
    this.router.delete(
      "/case-type/:caseTypeId/sections/:sectionId",
      validateRequest({ params: v.firmSectionParamsSchema }),
      ctrl.deleteFirmSection,
    );
    this.router.post(
      "/case-type/:caseTypeId/questions",
      validateRequest({ params: v.caseTypeIdParamsSchema, body: v.addFirmQuestionBodySchema }),
      ctrl.addFirmQuestion,
    );
    this.router.patch(
      "/case-type/:caseTypeId/questions/:questionId",
      validateRequest({ params: v.firmQuestionParamsSchema, body: v.updateFirmQuestionBodySchema }),
      ctrl.updateFirmQuestion,
    );
    this.router.delete(
      "/case-type/:caseTypeId/questions/:questionId",
      validateRequest({ params: v.firmQuestionParamsSchema }),
      ctrl.deleteFirmQuestion,
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
