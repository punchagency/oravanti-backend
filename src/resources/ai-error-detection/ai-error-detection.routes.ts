import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import {
  createFlag,
  getAllFlags,
  getFlagById,
  getStats,
  getSystemConfig,
  updateFlagStatus,
  updateSystemConfig,
} from "./ai-error-detection.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/stats", getStats);
router.get("/flags", getAllFlags);
router.get("/flags/:id", getFlagById);
router.post("/flags", createFlag);
router.patch("/flags/:id/status", updateFlagStatus);
router.get("/system-config", getSystemConfig);
router.patch("/system-config", updateSystemConfig);

export default router;
