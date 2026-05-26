import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import {
  createCalendarEvent,
  createServiceRequestEvent,
  deleteCalendarEvent,
  getCalendarEventById,
  getCalendarEvents,
  getCalendarStrip,
  resolveServiceRequestEvents,
  scheduleNextServiceRequest,
  updateCalendarEvent,
} from "./calendar.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/strip", getCalendarStrip);
router.get("/", getCalendarEvents);
router.get("/:id", getCalendarEventById);
router.post("/", createCalendarEvent);
router.patch("/:id", updateCalendarEvent);
router.delete("/:id", deleteCalendarEvent);

router.post("/service-requests", createServiceRequestEvent);
router.delete("/service-requests/:caseId", resolveServiceRequestEvents);
router.post("/service-requests/next", scheduleNextServiceRequest);

export default router;
