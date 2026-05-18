import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import { getApprovalWorkflows, updateApprovalWorkflows } from '../../controllers/settings/approval-workflows.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/', getApprovalWorkflows);
router.patch('/', updateApprovalWorkflows);

export default router;
