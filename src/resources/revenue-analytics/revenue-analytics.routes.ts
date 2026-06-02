import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { RevenueAnalyticsController } from "./revenue-analytics.controller";

export class RevenueAnalyticsRouter {
  public router: Router;
  public path: string;
  private revenueAnalyticsController: RevenueAnalyticsController;
  private validation: CommonValidation;

  constructor(
    revenueAnalyticsController: RevenueAnalyticsController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/revenue-analytics";
    this.revenueAnalyticsController = revenueAnalyticsController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get(
      "/",
      validateRequest({
        query: this.validation.query({
          period: this.validation
            .enumValue(["month", "quarter", "year", "all"])
            .optional(),
          teamId: this.validation.uuid.optional(),
        }),
      }),
      this.revenueAnalyticsController.getAnalytics,
    );
    this.router.get(
      "/export",
      validateRequest({
        query: this.validation.query({
          period: this.validation
            .enumValue(["month", "quarter", "year", "all"])
            .optional(),
          teamId: this.validation.uuid.optional(),
        }),
      }),
      this.revenueAnalyticsController.exportReport,
    );
  }
}
