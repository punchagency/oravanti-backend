import { CommonValidation } from "../../../validation/common.validation";
import { FirmInfoController } from "./firm-info.controller";
import { FirmInfoRouter } from "./firm-info.routes";
import { FirmInfoService } from "./firm-info.service";

export class FirmInfoModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new FirmInfoService();
    const controller = new FirmInfoController(service);
    const router = new FirmInfoRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
