import { CommonValidation } from "../../validation/common.validation";
import { CalendarController } from "./calendar.controller";
import { CalendarRouter } from "./calendar.routes";
import { CalendarService } from "./calendar.service";

export class CalendarModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const commonValidation = new CommonValidation();
    const service = new CalendarService();
    const controller = new CalendarController(service);
    const router = new CalendarRouter(controller, commonValidation);
    this.router = router.router;
    this.path = router.path;
  }
}
