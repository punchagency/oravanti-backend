/**
 * @openapi
 * tags:
 *   - name: Calendar
 *     description: Calendar events & service requests
 *
 * paths:
 *   /calendar/strip:
 *     get:
 *       tags: [Calendar]
 *       summary: Get 14-day calendar strip summary
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: teamId
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Calendar strip data
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/CalendarEvent"
 *
 *   /calendar/:
 *     get:
 *       tags: [Calendar]
 *       summary: List calendar events (filtered by month/year)
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: year
 *           schema: { type: integer }
 *         - in: query
 *           name: month
 *           schema: { type: integer }
 *         - in: query
 *           name: teamId
 *           schema: { type: string }
 *         - in: query
 *           name: eventTypes
 *           schema: { type: string }
 *           description: Comma-separated event types
 *       responses:
 *         200:
 *           description: List of events
 *           content:
 *             application/json:
 *               schema:
 *                 type: array
 *                 items:
 *                   $ref: "#/components/schemas/CalendarEvent"
 *     post:
 *       tags: [Calendar]
 *       summary: Create a calendar event
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CreateCalendarEventRequest"
 *       responses:
 *         201:
 *           description: Event created
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/CalendarEvent"
 *
 *   /calendar/{id}:
 *     get:
 *       tags: [Calendar]
 *       summary: Get event by ID
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Event data
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/CalendarEvent"
 *         404: { description: Event not found }
 *     patch:
 *       tags: [Calendar]
 *       summary: Update a calendar event
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/UpdateCalendarEventRequest"
 *       responses:
 *         200:
 *           description: Event updated
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/CalendarEvent"
 *         404: { description: Event not found }
 *     delete:
 *       tags: [Calendar]
 *       summary: Delete a calendar event
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Event deleted
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /calendar/service-requests:
 *     post:
 *       tags: [Calendar]
 *       summary: Create a service request event
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CreateServiceRequestRequest"
 *       responses:
 *         201:
 *           description: Service request created
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /calendar/service-requests/{caseId}:
 *     delete:
 *       tags: [Calendar]
 *       summary: Resolve all service request events for a case
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: caseId
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200:
 *           description: Service requests resolved
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 *
 *   /calendar/service-requests/next:
 *     post:
 *       tags: [Calendar]
 *       summary: Schedule the next service request (30 days out)
 *       security: [{ bearerAuth: [] }]
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: "#/components/schemas/CreateServiceRequestRequest"
 *       responses:
 *         201:
 *           description: Next service request scheduled
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: "#/components/schemas/MessageResponse"
 */
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
