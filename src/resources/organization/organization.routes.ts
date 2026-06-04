import { Router } from "express";
import { OrganizationController } from "./organization.controller";

export class OrganizationRouter {
  public router: Router;
  public path: string;
  private organizationController: OrganizationController;

  constructor(organizationController: OrganizationController) {
    this.organizationController = organizationController;
    this.router = Router();
    this.path = "/organization";

    this.initializeRoutes();
  }

  initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.post("/invite", this.organizationController.invite);
    this.router.post(
      "/accept-invitation",
      this.organizationController.acceptInvite,
    );
    this.router.get("/invitations", this.organizationController.getInvitations);
  }
}
