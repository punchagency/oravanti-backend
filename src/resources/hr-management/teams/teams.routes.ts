import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { TeamsController } from "./teams.controller";

export class TeamsRouter {
  public router: Router;
  public path: string;
  private teamsController: TeamsController;

  constructor(teamsController: TeamsController) {
    this.router = Router();
    this.path = "/hr/teams";
    this.teamsController = teamsController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/eligible-leads", this.teamsController.getEligibleLeads);
    this.router.get("/", this.teamsController.getAll);
    this.router.get("/:id", this.teamsController.getById);
    this.router.post("/", this.teamsController.createTeam);
    this.router.patch("/:id", this.teamsController.updateTeam);
    this.router.delete("/:id", this.teamsController.deleteTeam);
  }
}
