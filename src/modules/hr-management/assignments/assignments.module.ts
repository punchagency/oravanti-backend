import { CommonValidation } from "../../../validation/common.validation";
import { AssignmentsController } from "./assignments.controller";
import { AssignmentsRouter } from "./assignments.routes";
import { AssignmentsService } from "./assignments.service";

export class AssignmentsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new AssignmentsService();
    const controller = new AssignmentsController(service);
    const router = new AssignmentsRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
