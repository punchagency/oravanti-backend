import { AuditController } from "./audit.controller";
import { AuditRouter } from "./audit.routes";
import { AuditService } from "./audit.service";

export class AuditModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new AuditService();
    const controller = new AuditController(service);
    const router = new AuditRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
