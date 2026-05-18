import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../middleware/auth.middleware';
import { getProfile, updateProfile, uploadAvatar } from '../../controllers/settings/profile.controller';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(requireAuth);

router.get('/', getProfile);
router.patch('/', updateProfile);
router.post('/avatar', upload.single('avatar'), uploadAvatar);

export default router;
