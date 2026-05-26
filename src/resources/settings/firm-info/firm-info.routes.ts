import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { getFirmInfo, upsertFirmInfo } from "./firm-info.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/", getFirmInfo);
router.post("/", upsertFirmInfo);

export default router;
