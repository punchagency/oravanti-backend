import { Router } from "express";
import { requireAuth } from "../../../middleware/auth.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { FirmProfileController } from "./firm-profile.controller";

export class FirmProfileRouter {
  public router: Router;
  public path: string;
  private controller: FirmProfileController;

  constructor(controller: FirmProfileController) {
    this.router = Router();
    this.path = "/settings/firm-profile";
    this.controller = controller;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    this.router.get("/", this.controller.getProfile);
    this.router.put("/", this.controller.updateProfile);
    this.router.get("/snapshot", this.controller.getSnapshot);
    this.router.post("/export", this.controller.exportFirmData);
    this.router.delete("/", this.controller.deleteFirmAccount);
  }
}
