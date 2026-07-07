import { LeadsController } from "./leads.controller";
import {
  AgreementSigningRouter,
  AgreementsRouter,
  ConsultationBookingRouter,
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

// Public Dropbox Sign callback at /webhooks/dropbox-sign.
export class WebhooksModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new WebhooksRouter(buildController());
    this.router = router.router;
    this.path = router.path;
  }
}

// Public, token-gated client signing session at /agreement-signing/:token/session.
export class AgreementSigningModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new AgreementSigningRouter(buildController());
    this.router = router.router;
    this.path = router.path;
  }
}

// Public, token-gated lead-facing booking at /consultation-booking.
export class ConsultationBookingModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new ConsultationBookingRouter(buildController());
    this.router = router.router;
    this.path = router.path;
  }
}
