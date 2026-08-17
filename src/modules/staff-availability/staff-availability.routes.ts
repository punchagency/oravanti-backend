/**
 * @openapi
 * tags:
 *   - name: Staff Availability
 *     description: Per-staff consultation availability (hours, breaks, overrides, time off)
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";

import { requirePermission } from "../../middleware/permission.middleware";

import { validateRequest } from "../../middleware/validate.middleware";
import { StaffAvailabilityController } from "./staff-availability.controller";
import {
  createOverrideSchema,
  createTimeOffSchema,
  overrideParamsSchema,
  setBreaksSchema,
  setWeeklyAvailabilitySchema,
  staffIdParamsSchema,
  timeOffParamsSchema,
  updateOverrideSchema,
  updateTimeOffSchema,
} from "./staff-availability.validation";

// Admins own staff scheduling data: owner/admin can create/edit/delete any
// staff member's availability, breaks, overrides, and time off. Staff have
// read-only access (a request/review flow for staff is planned separately).
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
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

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
      requirePermission("staffs", "update"),
      this.controller.setWeeklyAvailability,
    );

    this.router.put(
      "/:staffId/breaks",
      validateRequest({
        params: staffIdParamsSchema,
        body: setBreaksSchema,
      }),
      requirePermission("staffs", "update"),
      this.controller.setBreaks,
    );

    this.router.post(
      "/:staffId/overrides",
      validateRequest({
        params: staffIdParamsSchema,
        body: createOverrideSchema,
      }),
      requirePermission("staffs", "create"),
      this.controller.createOverride,
    );

    this.router.patch(
      "/:staffId/overrides/:overrideId",
      validateRequest({
        params: overrideParamsSchema,
        body: updateOverrideSchema,
      }),
      requirePermission("staffs", "update"),
      this.controller.updateOverride,
    );

    this.router.delete(
      "/:staffId/overrides/:overrideId",
      validateRequest({ params: overrideParamsSchema }),
      requirePermission("staffs", "delete"),
      this.controller.deleteOverride,
    );

    this.router.post(
      "/:staffId/time-off",
      validateRequest({
        params: staffIdParamsSchema,
        body: createTimeOffSchema,
      }),
      requirePermission("staffs", "create"),
      this.controller.createTimeOff,
    );

    this.router.patch(
      "/:staffId/time-off/:timeOffId",
      validateRequest({
        params: timeOffParamsSchema,
        body: updateTimeOffSchema,
      }),
      requirePermission("staffs", "update"),
      this.controller.updateTimeOff,
    );

    this.router.delete(
      "/:staffId/time-off/:timeOffId",
      validateRequest({ params: timeOffParamsSchema }),
      requirePermission("staffs", "delete"),
      this.controller.deleteTimeOff,
    );
  }
}
