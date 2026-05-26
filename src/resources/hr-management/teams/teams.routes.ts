import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import {
  createTeam,
  deleteTeam,
  getAll,
  getById,
  getEligibleLeads,
  updateTeam,
} from "./teams.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/eligible-leads", getEligibleLeads);
router.get("/", getAll);
router.get("/:id", getById);
router.post("/", createTeam);
router.patch("/:id", updateTeam);
router.delete("/:id", deleteTeam);

export default router;
