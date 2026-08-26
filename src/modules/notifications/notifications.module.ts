import { CommonValidation } from "../../validation/common.validation";
import { NotificationsController } from "./notifications.controller";
import { NotificationsRouter } from "./notifications.routes";

export class NotificationsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const router = new NotificationsRouter(new NotificationsController(), new CommonValidation());
    this.router = router.router;
    this.path = router.path;
  }
}
