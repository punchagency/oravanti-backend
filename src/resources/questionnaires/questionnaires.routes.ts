import { Router } from "express";
import multer from "multer";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
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
    const validation = this.questionnairesValidation;

    this.router.get(
      "/client/:token",
      validateRequest({
        params: validation.questionnaireClientTokenParamsSchema,
      }),
      this.questionnairesController.getClientQuestionnaire,
    );
    this.router.put(
      "/client/:token/draft",
      validateRequest({
        params: validation.questionnaireClientTokenParamsSchema,
        body: validation.responseBodySchema,
      }),
      this.questionnairesController.saveDraftResponse,
    );
    this.router.post(
      "/client/:token/submit",
      validateRequest({
        params: validation.questionnaireClientTokenParamsSchema,
        body: validation.responseBodySchema,
      }),
      this.questionnairesController.submitResponse,
    );
    this.router.post(
      "/client/:token/files",
      this.upload.single("file"),
      validateRequest({
        params: validation.questionnaireClientTokenParamsSchema,
        body: validation.uploadResponseFileBodySchema,
      }),
      this.questionnairesController.uploadResponseFile,
    );

    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get(
      "/",
      validateRequest({ query: validation.listQuestionnairesQuerySchema }),
      this.questionnairesController.getAllQuestionnaires,
    );
    this.router.post(
      "/",
      validateRequest({ body: validation.createQuestionnaireBodySchema }),
      this.questionnairesController.createQuestionnaire,
    );
    this.router.get(
      "/eligible-for-case/:caseId",
      validateRequest({ params: validation.eligibleForCaseParamsSchema }),
      this.questionnairesController.getEligibleQuestionnairesForCase,
    );
    this.router.get(
      "/:id",
      validateRequest({ params: validation.questionnaireIdParamsSchema }),
      this.questionnairesController.getQuestionnaireById,
    );
    this.router.patch(
      "/:id",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        body: validation.updateQuestionnaireBodySchema,
      }),
      this.questionnairesController.updateQuestionnaire,
    );
    this.router.put(
      "/:id/case-types",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        body: validation.setQuestionnaireCaseTypesBodySchema,
      }),
      this.questionnairesController.setQuestionnaireCaseTypes,
    );
    this.router.post(
      "/:id/publish",
      validateRequest({ params: validation.questionnaireIdParamsSchema }),
      this.questionnairesController.publishQuestionnaire,
    );
    this.router.post(
      "/:id/duplicate",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        body: validation.duplicateQuestionnaireBodySchema,
      }),
      this.questionnairesController.duplicateQuestionnaire,
    );
    this.router.post(
      "/:id/sections",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        body: validation.addSectionBodySchema,
      }),
      this.questionnairesController.addSection,
    );
    this.router.patch(
      "/:id/sections/reorder",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        body: validation.reorderItemsBodySchema,
      }),
      this.questionnairesController.reorderSections,
    );
    this.router.post(
      "/:id/questions",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        body: validation.addQuestionBodySchema,
      }),
      this.questionnairesController.addQuestion,
    );
    this.router.patch(
      "/:id/questions/reorder",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        body: validation.reorderItemsBodySchema,
      }),
      this.questionnairesController.reorderQuestions,
    );
    this.router.patch(
      "/:id/questions/:questionId",
      validateRequest({
        params: validation.questionnaireQuestionParamsSchema,
        body: validation.updateQuestionBodySchema,
      }),
      this.questionnairesController.updateQuestion,
    );
    this.router.post(
      "/:id/logic-rules",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        body: validation.addLogicRuleBodySchema,
      }),
      this.questionnairesController.addLogicRule,
    );
    this.router.post(
      "/:id/send",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        body: validation.sendQuestionnaireBodySchema,
      }),
      this.questionnairesController.sendToClient,
    );
    this.router.get(
      "/:id/responses",
      validateRequest({
        params: validation.questionnaireIdParamsSchema,
        query: validation.listResponsesQuerySchema,
      }),
      this.questionnairesController.getResponses,
    );
  }
}
