import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import {
  getApprovalWorkflows,
  updateApprovalWorkflows,
} from "./approval-workflows.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/", getApprovalWorkflows);
router.patch("/", updateApprovalWorkflows);

export default router;
