import { CommonValidation } from "../../validation/common.validation";
import { ClientResponsivenessController } from "./client-responsiveness.controller";
import { ClientResponsivenessRouter } from "./client-responsiveness.routes";
import { ClientResponsivenessService } from "./client-responsiveness.service";

export class ClientResponsivenessModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new ClientResponsivenessService();
    const controller = new ClientResponsivenessController(service);
    const router = new ClientResponsivenessRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
