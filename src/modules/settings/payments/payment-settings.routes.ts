/**
 * @openapi
 * tags:
 *   - name: Settings - Payments
 *     description: The firm's payment-processor (Confido Legal) setup
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { requirePermission } from "../../../middleware/permission.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { validateRequest } from "../../../middleware/validate.middleware";
import { PaymentSettingsController } from "./payment-settings.controller";
import { setSurchargeSchema } from "./payment-settings.validation";

export class PaymentSettingsRouter {
  public router: Router;
  public path: string;
  private controller: PaymentSettingsController;

  constructor(controller: PaymentSettingsController) {
    this.router = Router();
    this.path = "/settings/payments";
    this.controller = controller;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // `finance:configure` rather than `finance:update`: binding the firm to a
    // payment processor is not invoice editing, and the two should not widen
    // together. Owner and admin hold it; attorney and paralegal do not.
    const configure = requirePermission({ finance: ["configure"] });

    // Read is on the same permission, not `finance:read`. The status of the
    // firm's merchant account is not something every timekeeper needs.
    this.router.get("/", configure, this.controller.getAccount);
    this.router.post(
      "/onboarding-session",
      configure,
      this.controller.startOnboarding,
    );
    this.router.post("/refresh", configure, this.controller.refresh);

    this.router.get("/surcharge", configure, this.controller.getSurcharge);
    this.router.patch(
      "/surcharge",
      configure,
      validateRequest({ body: setSurchargeSchema }),
      this.controller.setSurcharge,
    );

    // Connect (attaching an EXISTING Confido account) is intentionally not
    // exposed yet. `completeConnect` is implemented in the service, but the
    // authorize URL and whether Confido round-trips a `state` parameter are
    // undocumented — the spike could only introspect the exchange mutation's
    // signature. Shipping the endpoint without a signed `state` would let an
    // attacker-supplied code bind their firm to someone else's organization,
    // and shipping a constructed authorize URL would be fiction. Both wait on
    // an answer from Confido support.
  }
}
