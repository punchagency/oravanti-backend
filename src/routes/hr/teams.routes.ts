import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import { getAll, getById, createTeam, updateTeam, deleteTeam, getEligibleLeads } from '../../controllers/hr/teams.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/eligible-leads', getEligibleLeads);
router.get('/', getAll);
router.get('/:id', getById);
router.post('/', createTeam);
router.patch('/:id', updateTeam);
router.delete('/:id', deleteTeam);

export default router;
