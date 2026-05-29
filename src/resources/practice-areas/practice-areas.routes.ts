import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { PracticeAreasController } from "./practice-areas.controller";

export class PracticeAreasRouter {
  public router: Router;
  public path: string;
  private practiceAreasController: PracticeAreasController;

  constructor(practiceAreasController: PracticeAreasController) {
    this.router = Router();
    this.path = "/practice-areas";
    this.practiceAreasController = practiceAreasController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);

    this.router.get("/public", this.practiceAreasController.getAllPracticeAreas);
    this.router.get(
      "/firm",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      this.practiceAreasController.getFirmPracticeAreas,
    );
    this.router.post(
      "/subscriptions",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.practiceAreasController.createSubscriptions,
    );
    this.router.patch(
      "/subscriptions/cancel",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.practiceAreasController.cancelSubscriptions,
    );
  }
}
