import { CommonValidation } from "../../validation/common.validation";
import { RevenueAnalyticsController } from "./revenue-analytics.controller";
import { RevenueAnalyticsRouter } from "./revenue-analytics.routes";
import { RevenueAnalyticsService } from "./revenue-analytics.service";

export class RevenueAnalyticsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new RevenueAnalyticsService();
    const controller = new RevenueAnalyticsController(service);
    const router = new RevenueAnalyticsRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
