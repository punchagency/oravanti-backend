/**
 * @openapi
 * tags:
 *   - name: Revenue Analytics
 *     description: Revenue analytics & reporting
 *
 * paths:
 *   /revenue-analytics/:
 *     get:
 *       tags: [Revenue Analytics]
 *       summary: Get revenue analytics data
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: period
 *           schema:
 *             type: string
 *             enum: [month, quarter, year, all]
 *         - in: query
 *           name: teamId
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Revenue analytics data
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/RevenueAnalyticsResponse"
 *
 *   /revenue-analytics/export:
 *     get:
 *       tags: [Revenue Analytics]
 *       summary: Export revenue analytics report
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: period
 *           schema:
 *             type: string
 *             enum: [month, quarter, year, all]
 *         - in: query
 *           name: teamId
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Exported report with timestamp
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 */
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
