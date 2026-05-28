import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { AIErrorDetectionController } from "./ai-error-detection.controller";

export class AIErrorDetectionRouter {
  public router: Router;
  public path: string;
  private aiErrorDetectionController: AIErrorDetectionController;

  constructor(aiErrorDetectionController: AIErrorDetectionController) {
    this.router = Router();
    this.path = "/ai-error-detection";
    this.aiErrorDetectionController = aiErrorDetectionController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/stats", this.aiErrorDetectionController.getStats);
    this.router.get("/flags", this.aiErrorDetectionController.getAllFlags);
    this.router.get("/flags/:id", this.aiErrorDetectionController.getFlagById);
    this.router.post("/flags", this.aiErrorDetectionController.createFlag);
    this.router.patch(
      "/flags/:id/status",
      this.aiErrorDetectionController.updateFlagStatus,
    );
    this.router.get(
      "/system-config",
      this.aiErrorDetectionController.getSystemConfig,
    );
    this.router.patch(
      "/system-config",
      this.aiErrorDetectionController.updateSystemConfig,
    );
  }
}
