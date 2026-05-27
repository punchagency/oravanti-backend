import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { FinancialAccessController } from "./financial-access.controller";

export class FinancialAccessRouter {
  public router: Router;
  public path: string;
  private financialAccessController: FinancialAccessController;

  constructor(financialAccessController: FinancialAccessController) {
    this.router = Router();
    this.path = "/settings/financial-access";
    this.financialAccessController = financialAccessController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.financialAccessController.getFinancialAccess);
    this.router.patch(
      "/",
      this.financialAccessController.updateFinancialAccess,
    );
  }
}
