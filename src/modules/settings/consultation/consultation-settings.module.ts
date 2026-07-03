import { ConsultationSettingsController } from "./consultation-settings.controller";
import { ConsultationSettingsRouter } from "./consultation-settings.routes";
import { ConsultationSettingsService } from "./consultation-settings.service";

export class ConsultationSettingsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new ConsultationSettingsService();
    const controller = new ConsultationSettingsController(service);
    const router = new ConsultationSettingsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
