import { NotificationSettingsController } from "./notification-settings.controller";
import { NotificationSettingsRouter } from "./notification-settings.routes";
import { NotificationSettingsService } from "./notification-settings.service";

export class NotificationSettingsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new NotificationSettingsService();
    const controller = new NotificationSettingsController(service);
    const router = new NotificationSettingsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
