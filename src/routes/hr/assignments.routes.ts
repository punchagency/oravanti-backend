import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import {
  getAvailableContractors,
  assignCase,
  getAllAssignments,
  getAssignmentById,
  updateAssignmentStatus,
} from '../../controllers/hr/assignments.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/available-contractors', getAvailableContractors);
router.get('/', getAllAssignments);
router.get('/:id', getAssignmentById);
router.post('/', assignCase);
router.patch('/:id/status', updateAssignmentStatus);

export default router;
