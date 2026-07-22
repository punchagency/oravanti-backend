/**
 * @openapi
 * tags:
 *   - name: Document Requirements
 *     description: Firm-authored per-case-type document requirement templates
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { DocumentRequirementsController } from "./document-requirements.controller";
import {
  createBodySchema,
  listQuerySchema,
  updateBodySchema,
} from "./document-requirements.validation";

export class DocumentRequirementsRouter {
  public router: Router;
  public path: string;
  private controller: DocumentRequirementsController;

  constructor(controller: DocumentRequirementsController) {
    this.router = Router();
    this.path = "/document-requirements";
    this.controller = controller;
    this.initializeRoutes();
  }

  private initializeRoutes() {
    const { controller } = this;
    // Firm-authored templates — a case-review configuration action.
    this.router.use(
      requireAuth,
      resolveActorContext,
      requirePermission({ case_review: ["configure"] }),
    );

    this.router.get(
      "/",
      validateRequest({ query: listQuerySchema }),
      controller.list,
    );
    this.router.post(
      "/",
      validateRequest({ body: createBodySchema }),
      controller.create,
    );
    this.router.patch(
      "/:id",
      validateRequest({ body: updateBodySchema }),
      controller.update,
    );
    this.router.delete("/:id", controller.archive);
  }
}
