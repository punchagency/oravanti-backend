import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import {
  getCalendarEvents,
  getCalendarEventById,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getCalendarStrip,
  createServiceRequestEvent,
  resolveServiceRequestEvents,
  scheduleNextServiceRequest,
} from '../../controllers/calendar/calendar.controller';

const router = Router();

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/strip',                           getCalendarStrip);
router.get('/',                                getCalendarEvents);
router.get('/:id',                             getCalendarEventById);
router.post('/',                               createCalendarEvent);
router.patch('/:id',                           updateCalendarEvent);
router.delete('/:id',                          deleteCalendarEvent);

router.post('/service-requests',               createServiceRequestEvent);
router.delete('/service-requests/:caseId',     resolveServiceRequestEvents);
router.post('/service-requests/next',          scheduleNextServiceRequest);

export default router;
