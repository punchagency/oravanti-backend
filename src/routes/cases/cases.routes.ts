import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { requireStaffOrAdmin } from '../../middleware/staff-or-admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import {
  generateCaseNumber,
  getAllCases,
  getCaseById,
  createCase,
  updateCase,
  deleteCase,
} from '../../controllers/cases/cases.controller';

const router = Router();

router.get('/generate-number', requireAuth, requireAdmin,        setFirmContext, generateCaseNumber);
router.get('/',                requireAuth, requireAdmin,        setFirmContext, getAllCases);
router.get('/:id',             requireAuth, requireAdmin,        setFirmContext, getCaseById);
router.post('/',               requireAuth, requireStaffOrAdmin, setFirmContext, createCase);
router.patch('/:id',           requireAuth, requireAdmin,        setFirmContext, updateCase);
router.delete('/:id',          requireAuth, requireAdmin,        setFirmContext, deleteCase);

export default router;
