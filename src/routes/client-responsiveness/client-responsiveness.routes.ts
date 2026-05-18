import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import {
  getStats,
  getAllClientResponsiveness,
  addRequests,
  fulfillRequest,
  generateTerminationLetter,
  exportReport,
} from '../../controllers/client-responsiveness/client-responsiveness.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/stats',                                    getStats);
router.get('/',                                         getAllClientResponsiveness);
router.post('/:clientId/requests',                      addRequests);
router.patch('/requests/:requestId/fulfill',            fulfillRequest);
router.post('/:clientId/termination-letter',            generateTerminationLetter);
router.get('/:clientId/export',                         exportReport);

export default router;
