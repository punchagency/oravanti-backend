import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import {
  addRequests,
  exportReport,
  fulfillRequest,
  generateTerminationLetter,
  getAllClientResponsiveness,
  getStats,
} from "./client-responsiveness.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/stats", getStats);
router.get("/", getAllClientResponsiveness);
router.post("/:clientId/requests", addRequests);
router.patch("/requests/:requestId/fulfill", fulfillRequest);
router.post("/:clientId/termination-letter", generateTerminationLetter);
router.get("/:clientId/export", exportReport);

export default router;
