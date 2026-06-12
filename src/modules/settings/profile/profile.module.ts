import { CommonValidation } from "../../../validation/common.validation";
import { ProfileController } from "./profile.controller";
import { ProfileRouter } from "./profile.routes";
import { ProfileService } from "./profile.service";

export class ProfileModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new ProfileService();
    const controller = new ProfileController(service);
    const router = new ProfileRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
