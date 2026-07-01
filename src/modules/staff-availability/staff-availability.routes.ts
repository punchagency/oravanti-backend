/**
 * @openapi
 * tags:
 *   - name: Staff Availability
 *     description: Per-staff consultation availability (hours, breaks, overrides)
 */
import { NextFunction, Response, Router } from "express";
import { AuthRequest, requireAuth } from "../../middleware/auth.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { AuthorizationError } from "../../utils/error/app-error";
import { StaffAvailabilityController } from "./staff-availability.controller";
import {
  createOverrideSchema,
  overrideParamsSchema,
  setBreaksSchema,
  setWeeklyAvailabilitySchema,
  staffIdParamsSchema,
} from "./staff-availability.validation";

// Staff own their availability: writes are restricted to the staff member
// themselves. Admins can read any staff member's availability but not edit it.
const requireSelf = (req: AuthRequest, _res: Response, next: NextFunction) => {
  if (!req.staffId || req.staffId !== req.params.staffId) {
    throw new AuthorizationError("You can only manage your own availability");
  }
  next();
};

export class StaffAvailabilityRouter {
  public router: Router;
  public path: string;
  private controller: StaffAvailabilityController;

  constructor(controller: StaffAvailabilityController) {
    this.router = Router();
    this.path = "/staff-availability";
    this.controller = controller;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireStaffOrAdmin, setFirmContext);

    this.router.get(
      "/:staffId",
      validateRequest({ params: staffIdParamsSchema }),
      this.controller.getAvailability,
    );

    this.router.put(
      "/:staffId",
      validateRequest({
        params: staffIdParamsSchema,
        body: setWeeklyAvailabilitySchema,
      }),
      requireSelf,
      this.controller.setWeeklyAvailability,
    );

    this.router.put(
      "/:staffId/breaks",
      validateRequest({
        params: staffIdParamsSchema,
        body: setBreaksSchema,
      }),
      requireSelf,
      this.controller.setBreaks,
    );

    this.router.post(
      "/:staffId/overrides",
      validateRequest({
        params: staffIdParamsSchema,
        body: createOverrideSchema,
      }),
      requireSelf,
      this.controller.createOverride,
    );

    this.router.delete(
      "/:staffId/overrides/:overrideId",
      validateRequest({ params: overrideParamsSchema }),
      requireSelf,
      this.controller.deleteOverride,
    );
  }
}
