/**
 * @openapi
 * tags:
 *   - name: Settings - Notifications
 *     description: Per-firm notification channel preferences
 */
import { Router } from "express";

import { requireAuth } from "../../../middleware/auth.middleware";
import { requireResource } from "../../../middleware/permission.middleware";
import { resolveActorContext } from "../../../middleware/resolve-actor-context";
import { validateRequest } from "../../../middleware/validate.middleware";
import { NotificationSettingsController } from "./notification-settings.controller";
import {
  setSmsEnabledSchema,
  updateNotificationSettingsSchema,
} from "./notification-settings.validation";

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
    // GET -> firm_settings:read, PUT/PATCH -> firm_settings:update. The
    // resource is defined for exactly this surface ("general, billing,
    // notifications, compliance, payments"), and gating the router rather
    // than each route means a preference added later inherits the gate.
    this.router.use(requireResource("firm_settings"));

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

    /**
     * @openapi
     * /settings/notifications/sms:
     *   patch:
     *     tags: [Settings - Notifications]
     *     summary: Turn the firm-wide SMS master switch on or off
     *     description: >
     *       Writes only consultation_settings.sms_enabled. Deliberately
     *       separate from the consultation settings upsert, which is a full
     *       replace — sending it a partial body would null out the firm's fee
     *       configuration as a side effect of changing a messaging setting.
     *     responses:
     *       200:
     *         description: The new state of the switch
     */
    this.router.patch(
      "/sms",
      validateRequest({ body: setSmsEnabledSchema }),
      this.controller.setSmsEnabled,
    );
  }
}
