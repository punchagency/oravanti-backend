import { PaymentSettingsController } from "./payment-settings.controller";
import { PaymentSettingsRouter } from "./payment-settings.routes";

export class PaymentSettingsModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    // No service instance: this module's service is a set of exported functions
    // rather than a class, because the webhook worker needs to call the same
    // status-refresh logic without an HTTP request to hang a class off.
    const controller = new PaymentSettingsController();
    const router = new PaymentSettingsRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
