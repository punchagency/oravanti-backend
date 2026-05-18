import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import {
  getRoleOverview,
  getPermissions,
  savePermissions,
} from '../../controllers/settings/access-control.controller';
import {
  getCertificationGates,
  updateCertificationGates,
  getActivationRequirements,
  updateActivationRequirements,
} from '../../controllers/settings/certification-gates.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/overview', getRoleOverview);
router.get('/permissions', getPermissions);
router.post('/permissions', savePermissions);
router.get('/certification-gates', getCertificationGates);
router.post('/certification-gates', updateCertificationGates);
router.get('/activation-requirements', getActivationRequirements);
router.post('/activation-requirements', updateActivationRequirements);

export default router;
