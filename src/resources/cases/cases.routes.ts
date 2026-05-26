import { Router } from "express";
import { requireAdmin } from "../../middleware/admin.middleware";
import { requireAuth } from "../../middleware/auth.middleware";
import { setFirmContext } from "../../middleware/rls.middleware";
import { requireStaffOrAdmin } from "../../middleware/staff-or-admin.middleware";
import {
  createCase,
  deleteCase,
  generateCaseNumber,
  getAllCases,
  getCaseById,
  updateCase,
} from "./cases.controller";

const router = Router();

router.get(
  "/generate-number",
  requireAuth,
  requireAdmin,
  setFirmContext,
  generateCaseNumber,
);
router.get("/", requireAuth, requireAdmin, setFirmContext, getAllCases);
router.get("/:id", requireAuth, requireAdmin, setFirmContext, getCaseById);
router.post("/", requireAuth, requireStaffOrAdmin, setFirmContext, createCase);
router.patch("/:id", requireAuth, requireAdmin, setFirmContext, updateCase);
router.delete("/:id", requireAuth, requireAdmin, setFirmContext, deleteCase);

export default router;
