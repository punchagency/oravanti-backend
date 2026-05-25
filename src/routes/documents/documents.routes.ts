import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';
import { setFirmContext } from '../../middleware/rls.middleware';
import {
  getAllDocuments,
  getDocumentStats,
  getDocumentById,
  uploadDocument,
  updateDocumentStatus,
  getDownloadUrl,
  deleteDocument,
} from '../../controllers/documents/documents.controller';

const router  = Router();
const upload  = multer({ storage: multer.memoryStorage() });

router.use(requireAuth, requireAdmin, setFirmContext);

router.get('/stats',          getDocumentStats);
router.get('/',               getAllDocuments);
router.get('/:id',            getDocumentById);
router.get('/:id/download',   getDownloadUrl);
router.post('/', upload.single('file'), uploadDocument);
router.patch('/:id/status',   updateDocumentStatus);
router.delete('/:id',         deleteDocument);

export default router;
