import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import {
  getDataAccessControls,
  updateDataAccessControls,
} from "./data-access.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/", getDataAccessControls);
router.patch("/", updateDataAccessControls);

export default router;
