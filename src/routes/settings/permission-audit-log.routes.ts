import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import { getPermissionAuditLog } from '../../controllers/settings/permission-audit-log.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/', getPermissionAuditLog);

export default router;
