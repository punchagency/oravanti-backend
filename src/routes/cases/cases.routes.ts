import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
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

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/generate-number', generateCaseNumber);
router.get('/',                getAllCases);
router.get('/:id',             getCaseById);
router.post('/',               createCase);
router.patch('/:id',           updateCase);
router.delete('/:id',          deleteCase);

export default router;
