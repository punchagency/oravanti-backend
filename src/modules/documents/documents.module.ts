import { CommonValidation } from "../../validation/common.validation";
import { DocumentsController } from "./documents.controller";
import { DocumentsRouter } from "./documents.routes";
import { DocumentsService } from "./documents.service";

export class DocumentsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new DocumentsService();
    const controller = new DocumentsController(service);
    const router = new DocumentsRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
