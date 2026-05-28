import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { StaffController } from "./staffs.controller";

export class StaffRouter {
  public router: Router;
  public path: string;
  private staffController: StaffController;

  constructor(staffController: StaffController) {
    this.router = Router();
    this.path = "/hr/staff";
    this.staffController = staffController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/", this.staffController.getAll);
    this.router.get("/:id", this.staffController.getById);
    this.router.post("/", this.staffController.addStaff);
    this.router.patch("/:id", this.staffController.updateStaff);
    this.router.delete("/:id", this.staffController.deleteStaff);
  }
}
