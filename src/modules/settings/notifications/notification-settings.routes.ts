/**
 * @openapi
 * tags:
 *   - name: Settings - Notifications
 *     description: Per-firm notification channel preferences
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { validateRequest } from "../../../middleware/validate.middleware";
import { NotificationSettingsController } from "./notification-settings.controller";
import { updateNotificationSettingsSchema } from "./notification-settings.validation";

export class NotificationSettingsRouter {
  public router: Router;
  public path: string;
  private controller: NotificationSettingsController;

  constructor(controller: NotificationSettingsController) {
    this.router = Router();
    this.path = "/settings/notifications";
    this.controller = controller;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

    /**
     * @openapi
     * /settings/notifications:
     *   get:
     *     tags: [Settings - Notifications]
     *     summary: Get the firm's notification channel preferences
     *     description: >
     *       Always returns all preference events in catalog order. A firm that
     *       has never saved gets defaults, and no rows are written.
     *     responses:
     *       200:
     *         description: Notification settings
     */
    this.router.get("/", this.controller.getSettings);

    /**
     * @openapi
     * /settings/notifications:
     *   put:
     *     tags: [Settings - Notifications]
     *     summary: Update the firm's notification channel preferences
     *     description: >
     *       Upserts the supplied events. Omitted events keep their current
     *       value rather than being deleted. Unknown event keys are rejected.
     *       The `label` field is accepted and ignored — the server always
     *       answers with its own.
     *     responses:
     *       200:
     *         description: Updated notification settings
     */
    this.router.put(
      "/",
      validateRequest({ body: updateNotificationSettingsSchema }),
      this.controller.updateSettings,
    );
  }
}
