/**
 * @openapi
 * tags:
 *   - name: Settings - Fee agreements
 *     description: Firm-wide fee-agreement signing policy
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { requirePermission } from "../../../middleware/permission.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { validateRequest } from "../../../middleware/validate.middleware";
import { FeeAgreementSettingsController } from "./fee-agreement-settings.controller";
import { upsertFeeAgreementSettingsSchema } from "./fee-agreement-settings.validation";

export class FeeAgreementSettingsRouter {
  public router: Router;
  public path: string;
  private controller: FeeAgreementSettingsController;

  constructor(controller: FeeAgreementSettingsController) {
    this.router = Router();
    this.path = "/settings/fee-agreements";
    this.controller = controller;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // Reads stay open to any staff member, like the consultation settings
    // beside them: the fee-agreement generation wizard has to know whether to
    // show a signer picker at all, and a paralegal drafting an agreement is not
    // thereby a firm admin. Writes are firm configuration.
    const configure = requirePermission({ firm_settings: ["update"] });

    this.router.get("/", this.controller.getSettings);

    // Not gated on `fee_agreements:sign`. Reading who *may* sign is what the
    // wizard needs in order to render, and the person drafting an agreement is
    // routinely not the person who will execute it.
    this.router.get("/eligible-signers", this.controller.listEligibleSigners);

    this.router.put(
      "/",
      configure,
      validateRequest({ body: upsertFeeAgreementSettingsSchema }),
      this.controller.upsertSettings,
    );
  }
}
