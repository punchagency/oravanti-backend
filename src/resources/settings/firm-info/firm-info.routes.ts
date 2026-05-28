import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { FirmInfoController } from "./firm-info.controller";

export class FirmInfoRouter {
  public router: Router;
  public path: string;
  private firmInfoController: FirmInfoController;

  constructor(firmInfoController: FirmInfoController) {
    this.router = Router();
    this.path = "/settings/firm-info";
    this.firmInfoController = firmInfoController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.firmInfoController.getFirmInfo);
    this.router.post("/", this.firmInfoController.upsertFirmInfo);
  }
}
