import { RoleGroupsController } from "./role-groups.controller";
import { RoleGroupsRouter } from "./role-groups.routes";
import { RoleGroupsService } from "./role-groups.service";

export class RoleGroupsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new RoleGroupsService();
    const controller = new RoleGroupsController(service);
    const router = new RoleGroupsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
