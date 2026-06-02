import { Router } from "express";
import multer from "multer";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { QuestionnairesController } from "./questionnaires.controller";

export class QuestionnairesRouter {
  public router: Router;
  public path: string;
  private questionnairesController: QuestionnairesController;
  private upload: multer.Multer;

  constructor(questionnairesController: QuestionnairesController) {
    this.router = Router();
    this.path = "/questionnaires";
    this.questionnairesController = questionnairesController;
    this.upload = multer({ storage: multer.memoryStorage() });

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.get(
      "/client/:token",
      this.questionnairesController.getClientQuestionnaire,
    );
    this.router.put(
      "/client/:token/draft",
      this.questionnairesController.saveDraftResponse,
    );
    this.router.post(
      "/client/:token/submit",
      this.questionnairesController.submitResponse,
    );
    this.router.post(
      "/client/:token/files",
      this.upload.single("file"),
      this.questionnairesController.uploadResponseFile,
    );

    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.questionnairesController.getAllQuestionnaires);
    this.router.post("/", this.questionnairesController.createQuestionnaire);
    this.router.get(
      "/eligible-for-case/:caseId",
      this.questionnairesController.getEligibleQuestionnairesForCase,
    );
    this.router.get("/:id", this.questionnairesController.getQuestionnaireById);
    this.router.patch("/:id", this.questionnairesController.updateQuestionnaire);
    this.router.put(
      "/:id/case-types",
      this.questionnairesController.setQuestionnaireCaseTypes,
    );
    this.router.post(
      "/:id/publish",
      this.questionnairesController.publishQuestionnaire,
    );
    this.router.post(
      "/:id/duplicate",
      this.questionnairesController.duplicateQuestionnaire,
    );
    this.router.post("/:id/sections", this.questionnairesController.addSection);
    this.router.patch(
      "/:id/sections/reorder",
      this.questionnairesController.reorderSections,
    );
    this.router.post("/:id/questions", this.questionnairesController.addQuestion);
    this.router.patch(
      "/:id/questions/reorder",
      this.questionnairesController.reorderQuestions,
    );
    this.router.patch(
      "/:id/questions/:questionId",
      this.questionnairesController.updateQuestion,
    );
    this.router.post(
      "/:id/logic-rules",
      this.questionnairesController.addLogicRule,
    );
    this.router.post("/:id/send", this.questionnairesController.sendToClient);
    this.router.get("/:id/responses", this.questionnairesController.getResponses);
  }
}
