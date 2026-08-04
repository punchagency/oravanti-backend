import { StaffsController } from "./staffs.controller";
import { StaffsRouter } from "./staffs.routes";
import { StaffsService } from "./staffs.service";

export class StaffsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new StaffsService();
    const controller = new StaffsController(service);
    const router = new StaffsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
