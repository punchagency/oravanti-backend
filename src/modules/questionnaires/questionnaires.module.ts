import { QuestionnairesController } from "./questionnaires.controller";
import { QuestionnairesRouter } from "./questionnaires.routes";
import { QuestionnairesService } from "./questionnaires.service";
import { QuestionnairesValidation } from "./questionnaires.validation";

export class QuestionnairesModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new QuestionnairesService();
    const controller = new QuestionnairesController(service);
    const validation = new QuestionnairesValidation();
    const router = new QuestionnairesRouter(controller, validation);
    this.router = router.router;
    this.path = router.path;
  }
}
