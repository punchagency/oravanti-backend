import { CommonValidation } from "../../validation/common.validation";
import { AuthController } from "./auth.controller";
import { AuthRouter } from "./auth.routes";
import { AuthService } from "./auth.service";

export class AuthModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new AuthService();
    const controller = new AuthController(service);
    const router = new AuthRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
