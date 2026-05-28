import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { CertificationGatesController } from "../certification-gates/certification-gates.controller";
import { AccessControlController } from "./access-control.controller";

export class AccessControlRouter {
  public router: Router;
  public path: string;
  private accessControlController: AccessControlController;
  private certificationGatesController: CertificationGatesController;

  constructor(
    accessControlController: AccessControlController,
    certificationGatesController: CertificationGatesController,
  ) {
    this.router = Router();
    this.path = "/settings/access-control";
    this.accessControlController = accessControlController;
    this.certificationGatesController = certificationGatesController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/overview", this.accessControlController.getRoleOverview);
    this.router.get(
      "/permissions",
      this.accessControlController.getPermissions,
    );
    this.router.post(
      "/permissions",
      this.accessControlController.savePermissions,
    );
    this.router.get(
      "/certification-gates",
      this.certificationGatesController.getCertificationGates,
    );
    this.router.post(
      "/certification-gates",
      this.certificationGatesController.updateCertificationGates,
    );
    this.router.get(
      "/activation-requirements",
      this.certificationGatesController.getActivationRequirements,
    );
    this.router.post(
      "/activation-requirements",
      this.certificationGatesController.updateActivationRequirements,
    );
  }
}
