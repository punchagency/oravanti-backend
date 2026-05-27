import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { SecurityController } from "./security.controller";

export class SecurityRouter {
  public router: Router;
  public path: string;
  private securityController: SecurityController;

  constructor(securityController: SecurityController) {
    this.router = Router();
    this.path = "/settings/security";
    this.securityController = securityController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.post(
      "/change-password",
      this.securityController.changePassword,
    );
    this.router.get("/2fa/status", this.securityController.get2FAStatus);
    this.router.post("/2fa/enroll", this.securityController.enroll2FA);
    this.router.post("/2fa/verify", this.securityController.verify2FA);
    this.router.delete("/2fa/unenroll", this.securityController.unenroll2FA);
    this.router.get("/sessions", this.securityController.getSessions);
    this.router.delete("/sessions/:id", this.securityController.deleteSession);
  }
}
