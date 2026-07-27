/**
 * @openapi
 * tags:
 *   - name: Case Review
 *     description: AI case review dashboard — issues, stats, resolution log
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { CaseReviewController } from "./case-review.controller";
import {
  actionParamsSchema,
  listIssuesQuerySchema,
  paginationQuerySchema,
  resolutionLogQuerySchema,
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
    // Auth + actor context for the whole dashboard; permission varies per route.
    this.router.use(requireAuth, resolveActorContext);

    const read = requirePermission({ case_review: ["read"] });
    const resolve = requirePermission({ case_review: ["resolve"] });
    const configure = requirePermission({ case_review: ["configure"] });

    this.router.get("/stats", read, controller.getStats);

    this.router.get(
      "/issues",
      read,
      validateRequest({ query: listIssuesQuerySchema }),
      controller.getIssues,
    );

    this.router.get(
      "/by-case",
      read,
      validateRequest({ query: paginationQuerySchema }),
      controller.getByCase,
    );

    this.router.get(
      "/by-document",
      read,
      validateRequest({ query: paginationQuerySchema }),
      controller.getByDocument,
    );

    this.router.get(
      "/resolution-log",
      read,
      validateRequest({ query: resolutionLogQuerySchema }),
      controller.getResolutionLog,
    );

    this.router.get(
      "/issues/export",
      read,
      validateRequest({ query: listIssuesQuerySchema }),
      controller.exportIssues,
    );

    this.router.get(
      "/resolution-log/export",
      read,
      validateRequest({ query: resolutionLogQuerySchema }),
      controller.exportResolutionLog,
    );

    // Declared after the static paths so "/issues/by-case" can never be
    // swallowed by the :id param route.
    this.router.get("/issues/:id", read, controller.getIssueById);

    this.router.post(
      "/issues/:id/actions/:actionKey",
      resolve,
      validateRequest({ params: actionParamsSchema }),
      controller.runAction,
    );

    this.router.patch(
      "/issues/:id/status",
      resolve,
      validateRequest({ body: updateStatusBodySchema }),
      controller.updateStatus,
    );

    this.router.get("/config", configure, controller.getConfig);

    this.router.patch(
      "/config",
      configure,
      validateRequest({ body: updateConfigBodySchema }),
      controller.updateConfig,
    );
  }
}
