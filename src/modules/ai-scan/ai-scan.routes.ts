/**
 * @openapi
 * tags:
 *   - name: AI Scan
 *     description: Trigger AI document scans (manual re-run, full scan)
 */
import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
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
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    /**
     * @openapi
     * /ai-scan/rerun:
     *   post:
     *     tags: [AI Scan]
     *     summary: Manually (re-)scan a lead or case
     *     security: [{ bearerAuth: [] }]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [scenarioType, scenarioId]
     *             properties:
     *               scenarioType: { type: string, enum: [lead, case] }
     *               scenarioId: { type: string, format: uuid }
     *     responses:
     *       200: { description: Scan requested }
     */
    this.router.post(
      "/rerun",
      validateRequest({ body: rerunScanBodySchema }),
      this.controller.rerunScenario,
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
    this.router.post("/full-scan", this.controller.runFullScan);
  }
}
