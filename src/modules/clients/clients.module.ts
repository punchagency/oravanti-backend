import { CommonValidation } from "../../validation/common.validation";
import { ClientsController } from "./clients.controller";
import { ClientsRouter } from "./clients.routes";
import { ClientsService } from "./clients.service";

export class ClientsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new ClientsService();
    const controller = new ClientsController(service);
    const router = new ClientsRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
