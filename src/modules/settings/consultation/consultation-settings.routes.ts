/**
 * @openapi
 * tags:
 *   - name: Settings - Consultation
 *     description: Firm-wide consultation fee defaults & in-person locations
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
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

    // Reads are available to any staff member (the scheduling wizard needs them);
    // writes are restricted to firm admins.
    this.router.get("/", this.controller.getSettings);

    this.router.put(
      "/",
      validateRequest({ body: upsertConsultationSettingsSchema }),
      this.controller.upsertSettings,
    );

    this.router.get(
      "/locations",
      this.controller.listLocations,
    );

    this.router.post(
      "/locations",
      validateRequest({ body: createConsultationLocationSchema }),
      this.controller.createLocation,
    );

    this.router.patch(
      "/locations/:locationId",
      validateRequest({
        params: locationIdParamsSchema,
        body: updateConsultationLocationSchema,
      }),
      this.controller.updateLocation,
    );

    this.router.delete(
      "/locations/:locationId",
      validateRequest({ params: locationIdParamsSchema }),
      this.controller.deleteLocation,
    );
  }
}
