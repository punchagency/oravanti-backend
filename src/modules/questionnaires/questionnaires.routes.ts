import { Router } from "express";
import multer from "multer";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
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

    // ── Public token-based client endpoints ──────────────────────────────────
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

    // ── Authenticated staff-or-admin intake routes ───────────────────────────
    // Send-wizard data, response review, accept, and manual reminders are usable
    // by firm staff (attorney/paralegal), not just org admins.
    const staffGuards = [requireAuth, requireStaffOrAdmin, setFirmContext];

    this.router.get("/eligible-leads", ...staffGuards, ctrl.getEligibleLeads);
    this.router.get("/question-bank", ...staffGuards, ctrl.getQuestionBank);
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

    // ── Authenticated admin routes ────────────────────────────────────────────
    this.router.use(requireAuth, requireAdmin, setFirmContext);

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
