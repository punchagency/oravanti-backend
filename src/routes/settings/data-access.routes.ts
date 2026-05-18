import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import { getDataAccessControls, updateDataAccessControls } from '../../controllers/settings/data-access.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/', getDataAccessControls);
router.patch('/', updateDataAccessControls);

export default router;
