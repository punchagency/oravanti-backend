import { WorkflowTemplateController } from "./workflow-template.controller";
import { WorkflowTemplateRouter } from "./workflow-template.routes";

export class WorkflowTemplateModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new WorkflowTemplateRouter(new WorkflowTemplateController());
    this.router = router.router;
    this.path = router.path;
  }
}
