import { CommonValidation } from "../../validation/common.validation";
import { AIErrorDetectionController } from "./ai-error-detection.controller";
import { AIErrorDetectionRouter } from "./ai-error-detection.routes";
import { AIErrorDetectionService } from "./ai-error-detection.service";

export class AIErrorDetectionModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new AIErrorDetectionService();
    const controller = new AIErrorDetectionController(service);
    const router = new AIErrorDetectionRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
