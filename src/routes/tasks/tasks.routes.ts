import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import {
  getTaskStats,
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
} from '../../controllers/tasks/tasks.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/stats', getTaskStats);
router.get('/',      getAllTasks);
router.get('/:id',   getTaskById);
router.post('/',     createTask);
router.patch('/:id', updateTask);
router.delete('/:id', deleteTask);

export default router;
