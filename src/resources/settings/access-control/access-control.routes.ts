import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import {
  getActivationRequirements,
  getCertificationGates,
  updateActivationRequirements,
  updateCertificationGates,
} from "../certification-gates/certification-gates.controller";
import {
  getPermissions,
  getRoleOverview,
  savePermissions,
} from "./access-control.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get("/overview", getRoleOverview);
router.get("/permissions", getPermissions);
router.post("/permissions", savePermissions);
router.get("/certification-gates", getCertificationGates);
router.post("/certification-gates", updateCertificationGates);
router.get("/activation-requirements", getActivationRequirements);
router.post("/activation-requirements", updateActivationRequirements);

export default router;
