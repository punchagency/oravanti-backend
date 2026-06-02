import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { CommonValidation } from "../../../validation/common.validation";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { validateRequest } from "../../../middleware/validate.middleware";
import { TeamsController } from "./teams.controller";

export class TeamsRouter {
  public router: Router;
  public path: string;
  private teamsController: TeamsController;
  private validation: CommonValidation;

  constructor(teamsController: TeamsController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/hr/teams";
    this.teamsController = teamsController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/eligible-leads", this.teamsController.getEligibleLeads);
    this.router.get("/", this.teamsController.getAll);
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.teamsController.getById,
    );
    this.router.post(
      "/",
      validateRequest({ body: this.validation.requiredBody("name") }),
      this.teamsController.createTeam,
    );
    this.router.patch(
      "/:id",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
      }),
      this.teamsController.updateTeam,
    );
    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.teamsController.deleteTeam,
    );
  }
}
