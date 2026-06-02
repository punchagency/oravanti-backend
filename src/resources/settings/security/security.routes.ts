import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { SecurityController } from "./security.controller";

export class SecurityRouter {
  public router: Router;
  public path: string;
  private securityController: SecurityController;
  private validation: CommonValidation;

  constructor(securityController: SecurityController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/settings/security";
    this.securityController = securityController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.post(
      "/change-password",
      validateRequest({
        body: this.validation.requiredBody("currentPassword", "newPassword"),
      }),
      this.securityController.changePassword,
    );
    this.router.get("/2fa/status", this.securityController.get2FAStatus);
    this.router.post(
      "/2fa/enroll",
      validateRequest({ body: this.validation.requiredBody("password") }),
      this.securityController.enroll2FA,
    );
    this.router.post(
      "/2fa/verify",
      validateRequest({ body: this.validation.requiredBody("code") }),
      this.securityController.verify2FA,
    );
    this.router.delete(
      "/2fa/unenroll",
      validateRequest({ body: this.validation.requiredBody("password") }),
      this.securityController.unenroll2FA,
    );
    this.router.get("/sessions", this.securityController.getSessions);
    this.router.delete(
      "/sessions/:id",
      validateRequest({ params: this.validation.tokenParams("id") }),
      this.securityController.deleteSession,
    );
  }
}
