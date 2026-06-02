import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { CertificationGatesController } from "../certification-gates/certification-gates.controller";
import { AccessControlController } from "./access-control.controller";

export class AccessControlRouter {
  public router: Router;
  public path: string;
  private accessControlController: AccessControlController;
  private certificationGatesController: CertificationGatesController;
  private validation: CommonValidation;

  constructor(
    accessControlController: AccessControlController,
    certificationGatesController: CertificationGatesController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/access-control";
    this.accessControlController = accessControlController;
    this.certificationGatesController = certificationGatesController;
    this.validation = validation;

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
      validateRequest({ body: this.validation.requiredArrayBody("permissions") }),
      this.accessControlController.savePermissions,
    );
    this.router.get(
      "/certification-gates",
      this.certificationGatesController.getCertificationGates,
    );
    this.router.post(
      "/certification-gates",
      validateRequest({ body: this.validation.requiredArrayBody("gates") }),
      this.certificationGatesController.updateCertificationGates,
    );
    this.router.get(
      "/activation-requirements",
      this.certificationGatesController.getActivationRequirements,
    );
    this.router.post(
      "/activation-requirements",
      validateRequest({
        body: this.validation.arrayBody("certificationCodes"),
      }),
      this.certificationGatesController.updateActivationRequirements,
    );
  }
}
