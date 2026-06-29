/**
 * @openapi
 * tags:
 *   - name: Settings - Consultation
 *     description: Firm-wide consultation fee defaults & in-person locations
 */
import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { requireStaffOrAdmin } from "../../../middleware/staff-or-admin.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
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
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, setFirmContext);

    // Reads are available to any staff member (the scheduling wizard needs them);
    // writes are restricted to firm admins.
    this.router.get("/", requireStaffOrAdmin, this.controller.getSettings);

    this.router.put(
      "/",
      requireAdmin,
      validateRequest({ body: upsertConsultationSettingsSchema }),
      this.controller.upsertSettings,
    );

    this.router.get(
      "/locations",
      requireStaffOrAdmin,
      this.controller.listLocations,
    );

    this.router.post(
      "/locations",
      requireAdmin,
      validateRequest({ body: createConsultationLocationSchema }),
      this.controller.createLocation,
    );

    this.router.patch(
      "/locations/:locationId",
      requireAdmin,
      validateRequest({
        params: locationIdParamsSchema,
        body: updateConsultationLocationSchema,
      }),
      this.controller.updateLocation,
    );

    this.router.delete(
      "/locations/:locationId",
      requireAdmin,
      validateRequest({ params: locationIdParamsSchema }),
      this.controller.deleteLocation,
    );
  }
}
