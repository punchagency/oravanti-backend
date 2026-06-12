import { CommonValidation } from "../../validation/common.validation";
import { TasksController } from "./tasks.controller";
import { TasksRouter } from "./tasks.routes";
import { TasksService } from "./tasks.service";

export class TasksModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new TasksService();
    const controller = new TasksController(service);
    const router = new TasksRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
