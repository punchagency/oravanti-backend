import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { ClientResponsivenessController } from "./client-responsiveness.controller";

export class ClientResponsivenessRouter {
  public router: Router;
  public path: string;
  private clientResponsivenessController: ClientResponsivenessController;
  private validation: CommonValidation;

  constructor(
    clientResponsivenessController: ClientResponsivenessController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/client-responsiveness";
    this.clientResponsivenessController = clientResponsivenessController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/stats", this.clientResponsivenessController.getStats);
    this.router.get(
      "/",
      this.clientResponsivenessController.getAllClientResponsiveness,
    );
    this.router.post(
      "/:clientId/requests",
      validateRequest({
        params: this.validation.params("clientId"),
        body: this.validation.requiredBody("caseId").merge(
          this.validation.requiredArrayBody("items"),
        ),
      }),
      this.clientResponsivenessController.addRequests,
    );
    this.router.patch(
      "/requests/:requestId/fulfill",
      validateRequest({ params: this.validation.params("requestId") }),
      this.clientResponsivenessController.fulfillRequest,
    );
    this.router.post(
      "/:clientId/termination-letter",
      validateRequest({ params: this.validation.params("clientId") }),
      this.clientResponsivenessController.generateTerminationLetter,
    );
    this.router.get(
      "/:clientId/export",
      validateRequest({ params: this.validation.params("clientId") }),
      this.clientResponsivenessController.exportReport,
    );
  }
}
