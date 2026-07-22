/**
 * @openapi
 * tags:
 *   - name: AI Scan
 *     description: Trigger AI document scans (manual re-run, full scan)
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { AiScanController } from "./ai-scan.controller";
import { rerunScanBodySchema } from "./ai-scan.validation";

export class AiScanRouter {
  public router: Router;
  public path: string;
  private controller: AiScanController;

  constructor(controller: AiScanController) {
    this.router = Router();
    this.path = "/ai-scan";
    this.controller = controller;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { controller } = this;
    // Triggering a scan is a review action.
    this.router.use(
      requireAuth,
      resolveActorContext,
      requirePermission({ case_review: ["resolve"] }),
    );

    /**
     * @openapi
     * /ai-scan/rerun:
     *   post:
     *     tags: [AI Scan]
     *     summary: Manually (re-)scan a lead or case
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200: { description: Scan requested }
     */
    this.router.post(
      "/rerun",
      validateRequest({ body: rerunScanBodySchema }),
      controller.rerunScenario,
    );

    /**
     * @openapi
     * /ai-scan/full-scan:
     *   post:
     *     tags: [AI Scan]
     *     summary: Fan out a scan across every matter with documents
     *     security: [{ bearerAuth: [] }]
     *     responses:
     *       200: { description: Full scan started }
     */
    this.router.post("/full-scan", controller.runFullScan);
  }
}
