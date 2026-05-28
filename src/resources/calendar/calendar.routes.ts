import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { CalendarController } from "./calendar.controller";

export class CalendarRouter {
  public router: Router;
  public path: string;
  private calendarController: CalendarController;

  constructor(calendarController: CalendarController) {
    this.router = Router();
    this.path = "/calendar";
    this.calendarController = calendarController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth, requireAdmin, setFirmContext);

    this.router.get("/strip", this.calendarController.getCalendarStrip);
    this.router.get("/", this.calendarController.getCalendarEvents);
    this.router.get("/:id", this.calendarController.getCalendarEventById);
    this.router.post("/", this.calendarController.createCalendarEvent);
    this.router.patch("/:id", this.calendarController.updateCalendarEvent);
    this.router.delete("/:id", this.calendarController.deleteCalendarEvent);

    this.router.post(
      "/service-requests",
      this.calendarController.createServiceRequestEvent,
    );
    this.router.delete(
      "/service-requests/:caseId",
      this.calendarController.resolveServiceRequestEvents,
    );
    this.router.post(
      "/service-requests/next",
      this.calendarController.scheduleNextServiceRequest,
    );
  }
}
