import { CommonValidation } from "../../validation/common.validation";
import { WorkflowController } from "./workflow.controller";
import { WorkflowRouter } from "./workflow.routes";
import { WorkflowService } from "./workflow.service";

export class WorkflowModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new WorkflowService();
    const controller = new WorkflowController(service);
    const router = new WorkflowRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
