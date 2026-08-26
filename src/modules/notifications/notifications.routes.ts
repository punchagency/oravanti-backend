/**
 * @openapi
 * tags:
 *   - name: Notifications
 *     description: In-app and email notification history
 *
 * paths:
 *   /notifications/:
 *     get:
 *       tags: [Notifications]
 *       summary: List the signed-in user's notifications
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: query
 *           name: unreadOnly
 *           schema: { type: boolean }
 *       responses:
 *         200: { description: Notification list }
 *
 *   /notifications/{id}/read:
 *     patch:
 *       tags: [Notifications]
 *       summary: Mark a notification read
 *       security: [{ bearerAuth: [] }]
 *       parameters:
 *         - in: path
 *           name: id
 *           required: true
 *           schema: { type: string }
 *       responses:
 *         200: { description: Notification marked read }
 *         404: { description: Not found or already read }
 */
import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
import { validateRequest } from "../../middleware/validate.middleware";
import { CommonValidation } from "../../validation/common.validation";
import { NotificationsController } from "./notifications.controller";

export class NotificationsRouter {
  public router: Router;
  public path: string;

  constructor(controller: NotificationsController, validation: CommonValidation) {
    this.router = Router();
    this.path = "/notifications";

    // Deliberately `requireAuth` with no permission gate: these are the
    // caller's own notifications, scoped to them by the session in the
    // controller. A permission grant would be answering the wrong question —
    // reading your own mail is not a firm-level privilege.
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    this.router.get("/", controller.list);
    this.router.patch(
      "/:id/read",
      validateRequest({ params: validation.idParams }),
      controller.markRead,
    );
  }
}
