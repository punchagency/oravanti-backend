import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { setFirmContext } from "../../middleware/rls.middleware";
import { validateRequest } from "../../middleware/validate.middleware";
import { CalendarController } from "./calendar.controller";

export class CalendarRouter {
  public router: Router;
  public path: string;
  private calendarController: CalendarController;
  private validation: CommonValidation;

  constructor(
    calendarController: CalendarController,
    validation: CommonValidation,
  ) {
    this.router = Router();
    this.path = "/calendar";
    this.calendarController = calendarController;
    this.validation = validation;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/strip", this.calendarController.getCalendarStrip);
    this.router.get("/", this.calendarController.getCalendarEvents);
    this.router.get(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.calendarController.getCalendarEventById,
    );
    this.router.post(
      "/",
      validateRequest({ body: this.validation.optionalBody() }),
      this.calendarController.createCalendarEvent,
    );
    this.router.patch(
      "/:id",
      validateRequest({
        params: this.validation.idParams,
        body: this.validation.optionalBody(),
      }),
      this.calendarController.updateCalendarEvent,
    );
    this.router.delete(
      "/:id",
      validateRequest({ params: this.validation.idParams }),
      this.calendarController.deleteCalendarEvent,
    );

    this.router.post(
      "/service-requests",
      validateRequest({
        body: this.validation.requiredBody(
          "clientId",
          "caseId",
          "clientName",
          "formType",
        ),
      }),
      this.calendarController.createServiceRequestEvent,
    );
    this.router.delete(
      "/service-requests/:caseId",
      validateRequest({ params: this.validation.params("caseId") }),
      this.calendarController.resolveServiceRequestEvents,
    );
    this.router.post(
      "/service-requests/next",
      validateRequest({
        body: this.validation.requiredBody(
          "clientId",
          "caseId",
          "clientName",
          "formType",
        ),
      }),
      this.calendarController.scheduleNextServiceRequest,
    );
  }
}
