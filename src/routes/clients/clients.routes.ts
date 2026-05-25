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
  getAllCompanies,
  getCompanyById,
  createCompanyWithClients,
  updateCompany,
  deleteCompany,
  addClientToCompany,
} from '../../controllers/clients/clients.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/certifications',              getCertifications);
router.get('/teams/:teamId/staff',         getTeamStaff);

// Individual clients
router.get('/',                            getAllClients);
router.post('/',                           createClient);
router.get('/:id',                         getClientById);
router.patch('/:id',                       updateClient);
router.delete('/:id',                      deleteClient);

router.get('/:id/cases',                   getClientCases);
router.post('/:id/cases',                  addCase);
router.patch('/:id/cases/:caseId/status',  updateCaseStatus);

// Companies
router.get('/companies',                   getAllCompanies);
router.post('/companies',                  createCompanyWithClients);
router.get('/companies/:id',               getCompanyById);
router.patch('/companies/:id',             updateCompany);
router.delete('/companies/:id',            deleteCompany);
router.post('/companies/:id/clients',      addClientToCompany);

export default router;
