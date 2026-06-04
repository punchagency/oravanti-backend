import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { AIErrorDetectionController } from "./ai-error-detection.controller";

export class AIErrorDetectionRouter {
  public router: Router;
  public path: string;
  private aiErrorDetectionController: AIErrorDetectionController;
  private validation: CommonValidation;

  constructor(
    aiErrorDetectionController: AIErrorDetectionController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/ai-error-detection";
    this.aiErrorDetectionController = aiErrorDetectionController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/stats", this.aiErrorDetectionController.getStats);
    this.router.get("/flags", this.aiErrorDetectionController.getAllFlags);
    this.router.get(
      "/flags/:id",
      validateRequest({ params: this.validation.idParams }),
      this.aiErrorDetectionController.getFlagById,
    );
    this.router.post(
      "/flags",
      validateRequest({
        body: this.validation.requiredBody(
          "clientId",
          "caseId",
          "title",
          "description",
          "severity",
        ),
      }),
      this.aiErrorDetectionController.createFlag,
    );
    this.router.patch(
      "/flags/:id/status",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.requiredBody("status"),
      }),
      this.aiErrorDetectionController.updateFlagStatus,
    );
    this.router.get(
      "/system-config",
      this.aiErrorDetectionController.getSystemConfig,
    );
    this.router.patch(
      "/system-config",
      validateRequest({ body: this.validation.optionalBody() }),
      this.aiErrorDetectionController.updateSystemConfig,
    );
  }
}
