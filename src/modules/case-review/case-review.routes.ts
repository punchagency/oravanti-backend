/**
 * @openapi
 * tags:
 *   - name: Case Review
 *     description: AI case review dashboard — issues, stats, resolution log
 */
import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { CaseReviewController } from "./case-review.controller";
import {
  listIssuesQuerySchema,
  updateConfigBodySchema,
  updateStatusBodySchema,
} from "./case-review.validation";

export class CaseReviewRouter {
  public router: Router;
  public path: string;
  private controller: CaseReviewController;

  constructor(controller: CaseReviewController) {
    this.router = Router();
    this.path = "/case-review";
    this.controller = controller;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { controller } = this;

    this.router.get(
      "/stats",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      controller.getStats,
    );

    this.router.get(
      "/issues",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ query: listIssuesQuerySchema }),
      controller.getIssues,
    );

    this.router.get(
      "/issues/:id",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      controller.getIssueById,
    );

    this.router.patch(
      "/issues/:id/status",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      validateRequest({ body: updateStatusBodySchema }),
      controller.updateStatus,
    );

    this.router.get(
      "/config",
      requireAuth,
      requireAdmin,
      setFirmContext,
      controller.getConfig,
    );

    this.router.patch(
      "/config",
      requireAuth,
      requireAdmin,
      setFirmContext,
      validateRequest({ body: updateConfigBodySchema }),
      controller.updateConfig,
    );
  }
}
