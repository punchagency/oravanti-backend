import { RolesPermissionsController } from "./roles-permissions.controller";
import { RolesPermissionsRouter } from "./roles-permissions.routes";
import { RolesPermissionsService } from "./roles-permissions.service";

export class RolesPermissionsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new RolesPermissionsService();
    const controller = new RolesPermissionsController(service);
    const router = new RolesPermissionsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
