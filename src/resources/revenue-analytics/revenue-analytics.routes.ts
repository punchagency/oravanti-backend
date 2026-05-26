import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { exportReport, getAnalytics } from "./revenue-analytics.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/", getAnalytics);
router.get("/export", exportReport);

export default router;
