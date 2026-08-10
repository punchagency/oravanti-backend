import { FirmProfileController } from "./firm-profile.controller";
import { FirmProfileRouter } from "./firm-profile.routes";
import { FirmProfileService } from "./firm-profile.service";

export class FirmProfileModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new FirmProfileService();
    const controller = new FirmProfileController(service);
    const router = new FirmProfileRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
