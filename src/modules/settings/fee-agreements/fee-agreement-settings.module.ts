import { FeeAgreementSettingsController } from "./fee-agreement-settings.controller";
import { FeeAgreementSettingsRouter } from "./fee-agreement-settings.routes";
import { FeeAgreementSettingsService } from "./fee-agreement-settings.service";

export class FeeAgreementSettingsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new FeeAgreementSettingsService();
    const controller = new FeeAgreementSettingsController(service);
    const router = new FeeAgreementSettingsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
