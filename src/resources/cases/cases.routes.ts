import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import { CasesController } from "./cases.controller";

export class CasesRouter {
  public router: Router;
  public path: string;
  private casesController: CasesController;

  constructor(casesController: CasesController) {
    this.router = Router();
    this.path = "/cases";
    this.casesController = casesController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);

    this.router.get(
      "/generate-number",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.casesController.generateCaseNumber,
    );
    this.router.get(
      "/",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.casesController.getAllCases,
    );
    this.router.get(
      "/:id",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.casesController.getCaseById,
    );
    this.router.post(
      "/",
      requireAuth,
      requireStaffOrAdmin,
      setFirmContext,
      this.casesController.createCase,
    );
    this.router.patch(
      "/:id",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.casesController.updateCase,
    );
    this.router.delete(
      "/:id",
      requireAuth,
      requireAdmin,
      setFirmContext,
      this.casesController.deleteCase,
    );
  }
}
