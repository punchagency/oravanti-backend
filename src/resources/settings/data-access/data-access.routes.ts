import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { DataAccessController } from "./data-access.controller";

export class DataAccessRouter {
  public router: Router;
  public path: string;
  private dataAccessController: DataAccessController;

  constructor(dataAccessController: DataAccessController) {
    this.router = Router();
    this.path = "/settings/data-access";
    this.dataAccessController = dataAccessController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.dataAccessController.getDataAccessControls);
    this.router.patch("/", this.dataAccessController.updateDataAccessControls);
  }
}
