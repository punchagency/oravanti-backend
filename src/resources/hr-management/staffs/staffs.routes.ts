import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import {
  addStaff,
  deleteStaff,
  getAll,
  getById,
  updateStaff,
} from "./staffs.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/", getAll);
router.get("/:id", getById);
router.post("/", addStaff);
router.patch("/:id", updateStaff);
router.delete("/:id", deleteStaff);

export default router;
