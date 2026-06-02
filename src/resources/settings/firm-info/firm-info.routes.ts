import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { FirmInfoController } from "./firm-info.controller";

export class FirmInfoRouter {
  public router: Router;
  public path: string;
  private firmInfoController: FirmInfoController;
  private validation: CommonValidation;

  constructor(
    firmInfoController: FirmInfoController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/firm-info";
    this.firmInfoController = firmInfoController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.firmInfoController.getFirmInfo);
    this.router.post(
      "/",
      validateRequest({ body: this.validation.requiredBody("firmName", "firmEmail") }),
      this.firmInfoController.upsertFirmInfo,
    );
  }
}
