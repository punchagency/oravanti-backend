import { StaffAvailabilityController } from "./staff-availability.controller";
import { StaffAvailabilityRouter } from "./staff-availability.routes";
import { StaffAvailabilityService } from "./staff-availability.service";

export class StaffAvailabilityModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new StaffAvailabilityService();
    const controller = new StaffAvailabilityController(service);
    const router = new StaffAvailabilityRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
