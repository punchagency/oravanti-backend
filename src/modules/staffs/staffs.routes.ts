/**
 * @openapi
 * tags:
 *   - name: Staff
 *     description: Staff self-service (own profile)
 */
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { preserveRequestContext } from "../../middleware/request-context";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { StaffsController } from "./staffs.controller";

const updateOwnProfileBody = z
  .object({
    firstName: z.string().trim().min(2, "First name is required").optional(),
    lastName: z.string().trim().min(2, "Last name is required").optional(),
    email: z.string().email("Invalid email address").optional(),
    phone: z.string().trim().min(10, "Invalid phone number").optional(),
    barNumber: z.string().trim().optional(),
  })
  .strict();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, GIF, and WebP images are allowed"));
    }
  },
});

export class StaffsRouter {
  public router: Router;
  public path: string;
  private staffsController: StaffsController;

  constructor(staffsController: StaffsController) {
    this.staffsController = staffsController;
    this.router = Router();
    this.path = "/staffs";

    this.initializeRoutes();
  }

  initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    this.router.get(
      "/profile",
      requirePermission("staffs", "read"),
      this.staffsController.getOwnProfile,
    );
    this.router.patch(
      "/profile",
      requirePermission("staffs", "read"),
      validateRequest({ body: updateOwnProfileBody }),
      this.staffsController.updateOwnProfile,
    );
    this.router.post(
      "/avatar",
      requirePermission("staffs", "read"),
      preserveRequestContext(upload.single("avatar")),
      this.staffsController.uploadAvatar,
    );
  }
}
