import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import { getPermissionAuditLog } from "./permission-audit-log.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/", getPermissionAuditLog);

export default router;
