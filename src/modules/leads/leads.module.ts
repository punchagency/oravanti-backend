import { LeadsController } from "./leads.controller";
import { LeadsRouter } from "./leads.routes";
import { LeadsService } from "./leads.service";

export class LeadsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new LeadsService();
    const controller = new LeadsController(service);
    const router = new LeadsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
