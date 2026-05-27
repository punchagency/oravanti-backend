import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { AssignmentsController } from "./assignments.controller";

export class AssignmentsRouter {
  public router: Router;
  public path: string;
  private assignmentsController: AssignmentsController;

  constructor(assignmentsController: AssignmentsController) {
    this.router = Router();
    this.path = "/hr/assignments";
    this.assignmentsController = assignmentsController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get(
      "/available-contractors",
      this.assignmentsController.getAvailableContractors,
    );
    this.router.get("/", this.assignmentsController.getAllAssignments);
    this.router.get("/:id", this.assignmentsController.getAssignmentById);
    this.router.post("/", this.assignmentsController.assignCase);
    this.router.patch(
      "/:id/status",
      this.assignmentsController.updateAssignmentStatus,
    );
  }
}
