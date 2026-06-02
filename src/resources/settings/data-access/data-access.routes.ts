import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { DataAccessController } from "./data-access.controller";

export class DataAccessRouter {
  public router: Router;
  public path: string;
  private dataAccessController: DataAccessController;
  private validation: CommonValidation;

  constructor(
    dataAccessController: DataAccessController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/settings/data-access";
    this.dataAccessController = dataAccessController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.dataAccessController.getDataAccessControls);
    this.router.patch(
      "/",
      validateRequest({ body: this.validation.requiredArrayBody("controls") }),
      this.dataAccessController.updateDataAccessControls,
    );
  }
}
