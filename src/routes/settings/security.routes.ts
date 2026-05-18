import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import {
  changePassword,
  get2FAStatus,
  enroll2FA,
  verify2FA,
  unenroll2FA,
  getSessions,
  deleteSession,
} from '../../controllers/settings/security.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.post('/change-password',  changePassword);
router.get('/2fa/status',        get2FAStatus);
router.post('/2fa/enroll',       enroll2FA);
router.post('/2fa/verify',       verify2FA);
router.delete('/2fa/unenroll',   unenroll2FA);
router.get('/sessions',          getSessions);
router.delete('/sessions/:id',   deleteSession);

export default router;
