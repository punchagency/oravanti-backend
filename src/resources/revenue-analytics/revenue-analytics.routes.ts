import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { RevenueAnalyticsController } from "./revenue-analytics.controller";

export class RevenueAnalyticsRouter {
  public router: Router;
  public path: string;
  private revenueAnalyticsController: RevenueAnalyticsController;

  constructor(revenueAnalyticsController: RevenueAnalyticsController) {
    this.router = Router();
    this.path = "/revenue-analytics";
    this.revenueAnalyticsController = revenueAnalyticsController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.revenueAnalyticsController.getAnalytics);
    this.router.get("/export", this.revenueAnalyticsController.exportReport);
  }
}
