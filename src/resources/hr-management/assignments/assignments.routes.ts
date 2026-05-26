import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import {
  assignCase,
  getAllAssignments,
  getAssignmentById,
  getAvailableContractors,
  updateAssignmentStatus,
} from "./assignments.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/available-contractors", getAvailableContractors);
router.get("/", getAllAssignments);
router.get("/:id", getAssignmentById);
router.post("/", assignCase);
router.patch("/:id/status", updateAssignmentStatus);

export default router;
