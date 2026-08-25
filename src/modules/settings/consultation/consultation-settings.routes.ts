/**
 * @openapi
 * tags:
 *   - name: Settings - Consultation
 *     description: Firm-wide consultation fee defaults & in-person locations
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { requirePermission } from "../../../middleware/permission.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";


import { validateRequest } from "../../../middleware/validate.middleware";
import { ConsultationSettingsController } from "./consultation-settings.controller";
import {
  createConsultationLocationSchema,
  locationIdParamsSchema,
  updateConsultationLocationSchema,
  upsertConsultationSettingsSchema,
} from "./consultation-settings.validation";

export class ConsultationSettingsRouter {
  public router: Router;
  public path: string;
  private controller: ConsultationSettingsController;

  constructor(controller: ConsultationSettingsController) {
    this.router = Router();
    this.path = "/settings/consultation";
    this.controller = controller;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    // Reads stay open to any staff member — the scheduling wizard needs the fee
    // defaults and the location list to render at all, and a paralegal booking a
    // consultation is not thereby an admin.
    //
    // Writes are `firm_settings:update`, which is what the comment here has
    // always claimed and what nothing enforced: until now every route in this
    // file carried `requireAuth` and nothing else, so any authenticated member
    // of the firm could rewrite the consultation fee, the deposit percentage,
    // the no-show policy, the firm timezone and the SMS master switch.
    const configure = requirePermission({ firm_settings: ["update"] });

    this.router.get("/", this.controller.getSettings);

    this.router.put(
      "/",
      configure,
      validateRequest({ body: upsertConsultationSettingsSchema }),
      this.controller.upsertSettings,
    );

    this.router.get(
      "/locations",
      this.controller.listLocations,
    );

    this.router.post(
      "/locations",
      configure,
      validateRequest({ body: createConsultationLocationSchema }),
      this.controller.createLocation,
    );

    this.router.patch(
      "/locations/:locationId",
      configure,
      validateRequest({
        params: locationIdParamsSchema,
        body: updateConsultationLocationSchema,
      }),
      this.controller.updateLocation,
    );

    this.router.delete(
      "/locations/:locationId",
      configure,
      validateRequest({ params: locationIdParamsSchema }),
      this.controller.deleteLocation,
    );
  }
}
