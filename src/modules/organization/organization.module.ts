import { OrganizationController } from "./organization.controller";
import { OrganizationRouter } from "./organization.routes";
import { OrganizationService } from "./organization.service";

export class OrganizationModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new OrganizationService();
    const controller = new OrganizationController(service);
    const router = new OrganizationRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
