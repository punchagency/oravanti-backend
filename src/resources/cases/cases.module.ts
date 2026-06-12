import { CommonValidation } from "../../validation/common.validation";
import { CasesController } from "./cases.controller";
import { CasesRouter } from "./cases.routes";
import { CasesService } from "./cases.service";

export class CasesModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new CasesService();
    const controller = new CasesController(service);
    const router = new CasesRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
