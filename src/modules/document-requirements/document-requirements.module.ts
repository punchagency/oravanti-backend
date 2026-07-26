import { DocumentRequirementsController } from "./document-requirements.controller";
import { DocumentRequirementsRouter } from "./document-requirements.routes";
import { DocumentRequirementsService } from "./document-requirements.service";

export class DocumentRequirementsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new DocumentRequirementsService();
    const controller = new DocumentRequirementsController(service);
    const router = new DocumentRequirementsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
