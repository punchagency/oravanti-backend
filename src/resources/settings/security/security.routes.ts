import { Router } from "express";
import { requireAdmin } from "../../../middleware/admin.middleware";
import { requireAuth } from "../../../middleware/auth.middleware";
import { setFirmContext } from "../../../middleware/rls.middleware";
import {
  changePassword,
  deleteSession,
  enroll2FA,
  get2FAStatus,
  getSessions,
  unenroll2FA,
  verify2FA,
} from "./security.controller";

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.post("/change-password", changePassword);
router.get("/2fa/status", get2FAStatus);
router.post("/2fa/enroll", enroll2FA);
router.post("/2fa/verify", verify2FA);
router.delete("/2fa/unenroll", unenroll2FA);
router.get("/sessions", getSessions);
router.delete("/sessions/:id", deleteSession);

export default router;
