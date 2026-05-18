import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import { getFirmInfo, upsertFirmInfo } from '../../controllers/settings/firm-info.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/', getFirmInfo);
router.post('/', upsertFirmInfo);

export default router;
