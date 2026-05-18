import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import { getFinancialAccess, updateFinancialAccess } from '../../controllers/settings/financial-access.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/', getFinancialAccess);
router.patch('/', updateFinancialAccess);

export default router;
