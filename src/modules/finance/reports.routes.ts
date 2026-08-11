/**
 * @openapi
 * tags:
 *   - name: Finance — Reports
 *     description: Monthly financial reporting and trust reconciliation
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { FinanceReportsController } from "./reports.controller";
import {
  exportReportQuerySchema,
  reportQuerySchema,
} from "./time-billing.validation";

export class FinanceReportsRouter {
  public router: Router;
  public path: string;
  private controller: FinanceReportsController;

  constructor(controller: FinanceReportsController) {
    this.router = Router();
    this.path = "/finance/reports";
    this.controller = controller;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { controller } = this;

    this.router.use(requireAuth, resolveActorContext);
    const read = requirePermission({ finance: ["read"] });

    this.router.get(
      "/export",
      read,
      validateRequest({ query: exportReportQuerySchema }),
      controller.export,
    );

    /**
     * @openapi
     * /finance/reports:
     *   get:
     *     tags: [Finance — Reports]
     *     summary: The whole month's report in one payload
     *     description: >
     *       Deliberately one endpoint: the UI renders a single screen, so
     *       separate calls per panel would be separate chances to display
     *       mutually inconsistent numbers.
     *     responses:
     *       200: { description: Report retrieved }
     */
    this.router.get(
      "/",
      read,
      validateRequest({ query: reportQuerySchema }),
      controller.getReport,
    );
  }
}
