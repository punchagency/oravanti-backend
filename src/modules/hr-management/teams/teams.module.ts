import { CommonValidation } from "../../../validation/common.validation";
import { TeamsController } from "./teams.controller";
import { TeamsRouter } from "./teams.routes";
import { TeamsService } from "./teams.service";

export class TeamsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new TeamsService();
    const controller = new TeamsController(service);
    const router = new TeamsRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
