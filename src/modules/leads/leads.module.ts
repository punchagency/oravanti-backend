import { LeadsController } from "./leads.controller";
import {
  AgreementsRouter,
  LeadsRouter,
  WebhooksRouter,
} from "./leads.routes";
import { LeadsService } from "./leads.service";

const buildController = () => new LeadsController(new LeadsService());

export class LeadsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new LeadsRouter(buildController());
    this.router = router.router;
    this.path = router.path;
  }
}

// Fee-agreement actions live under /agreements/:agreementId (nudge, send,
// mark-received).
export class AgreementsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new AgreementsRouter(buildController());
    this.router = router.router;
    this.path = router.path;
  }
}

// Public e-signature callback at /webhooks/esignature.
export class WebhooksModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new WebhooksRouter(buildController());
    this.router = router.router;
    this.path = router.path;
  }
}
