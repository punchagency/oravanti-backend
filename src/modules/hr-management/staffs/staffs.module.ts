import { CommonValidation } from "../../../validation/common.validation";
import { StaffController } from "./staffs.controller";
import { StaffRouter } from "./staffs.routes";
import { StaffService } from "./staffs.service";

export class StaffModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new StaffService();
    const controller = new StaffController(service);
    const router = new StaffRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
