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

    this.router.get(
      "/",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      this.practiceAreasController.getAllPracticeAreas,
    );
    this.router.get(
      "/:id",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.practiceAreasController.getPracticeAreaById,
    );
    this.router.post(
      "/",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.practiceAreasController.createPracticeArea,
    );
    this.router.patch(
      "/:id",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.practiceAreasController.updatePracticeArea,
    );
    this.router.delete(
      "/:id",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.practiceAreasController.deletePracticeArea,
    );
  }
}
