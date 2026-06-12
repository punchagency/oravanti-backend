import { CommonValidation } from "../../validation/common.validation";
import { PracticeAreasController } from "./practice-areas.controller";
import { PracticeAreasRouter } from "./practice-areas.routes";
import { PracticeAreasService } from "./practice-areas.service";

export class PracticeAreasModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new PracticeAreasService();
    const controller = new PracticeAreasController(service);
    const router = new PracticeAreasRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
