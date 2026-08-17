import { DocumentsService } from "../documents/documents.service";
import { CasesController } from "./cases.controller";
import { CasesRouter } from "./cases.routes";
import { CasesService } from "./cases.service";

export class CasesModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new CasesService();
    const documentsService = new DocumentsService();
    const controller = new CasesController(service, documentsService);
    const router = new CasesRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
