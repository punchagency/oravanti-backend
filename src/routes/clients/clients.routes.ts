import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import {
  getCertifications,
  getAllClients,
  getClientById,
  createClient,
  updateClient,
  deleteClient,
  getClientCases,
  addCase,
  updateCaseStatus,
  getTeamStaff,
} from '../../controllers/clients/clients.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/certifications',              getCertifications);
router.get('/teams/:teamId/staff',         getTeamStaff);

router.get('/',                            getAllClients);
router.post('/',                           createClient);
router.get('/:id',                         getClientById);
router.patch('/:id',                       updateClient);
router.delete('/:id',                      deleteClient);

router.get('/:id/cases',                   getClientCases);
router.post('/:id/cases',                  addCase);
router.patch('/:id/cases/:caseId/status',  updateCaseStatus);

export default router;
