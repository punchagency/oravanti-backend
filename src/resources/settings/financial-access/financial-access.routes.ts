import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import {
  getFinancialAccess,
  updateFinancialAccess,
} from "./financial-access.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/", getFinancialAccess);
router.patch("/", updateFinancialAccess);

export default router;
