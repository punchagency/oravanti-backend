import { CommonValidation } from "../../../validation/common.validation";
import { SecurityController } from "./security.controller";
import { SecurityRouter } from "./security.routes";
import { SecurityService } from "./security.service";

export class SecurityModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new SecurityService();
    const controller = new SecurityController(service);
    const router = new SecurityRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
