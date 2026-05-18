import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import { getAll, getById, addStaff, updateStaff, deleteStaff } from '../../controllers/hr/staff.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/', getAll);
router.get('/:id', getById);
router.post('/', addStaff);
router.patch('/:id', updateStaff);
router.delete('/:id', deleteStaff);

export default router;
