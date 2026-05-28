import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { ClientResponsivenessController } from "./client-responsiveness.controller";

export class ClientResponsivenessRouter {
  public router: Router;
  public path: string;
  private clientResponsivenessController: ClientResponsivenessController;

  constructor(clientResponsivenessController: ClientResponsivenessController) {
    this.router = Router();
    this.path = "/client-responsiveness";
    this.clientResponsivenessController = clientResponsivenessController;

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
      this.clientResponsivenessController.addRequests,
    );
    this.router.patch(
      "/requests/:requestId/fulfill",
      this.clientResponsivenessController.fulfillRequest,
    );
    this.router.post(
      "/:clientId/termination-letter",
      this.clientResponsivenessController.generateTerminationLetter,
    );
    this.router.get(
      "/:clientId/export",
      this.clientResponsivenessController.exportReport,
    );
  }
}
