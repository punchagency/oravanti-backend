/**
 * @openapi
 * tags:
 *   - name: Document Requirements
 *     description: Firm-authored per-case-type document requirement templates
 */
import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
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
    // Firm-authored templates — admin only.
    this.router.use(requireAuth, requireAdmin, setFirmContext);

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
