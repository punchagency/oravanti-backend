import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { PracticeAreasController } from "./practice-areas.controller";

export class PracticeAreasRouter {
  public router: Router;
  public path: string;
  private practiceAreasController: PracticeAreasController;
  private validation: CommonValidation;

  constructor(
    practiceAreasController: PracticeAreasController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/practice-areas";
    this.practiceAreasController = practiceAreasController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);

    this.router.get("/public", this.practiceAreasController.getAllPracticeAreas);
    this.router.get(
      "/firm",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      this.practiceAreasController.getFirmPracticeAreas,
    );
    this.router.post(
      "/subscriptions",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ body: this.validation.optionalBody() }),
      this.practiceAreasController.createSubscriptions,
    );
    this.router.patch(
      "/subscriptions/cancel",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ body: this.validation.optionalBody() }),
      this.practiceAreasController.cancelSubscriptions,
    );
  }
}
