import { OnboardingController } from "./onboarding.controller";
import { OnboardingRouter } from "./onboarding.routes";
import { OnboardingService } from "./onboarding.service";

export class OnboardingModule {
  public router: import("express").Router;
  public path: string;

  constructor() {
    const service = new OnboardingService();
    const controller = new OnboardingController(service);
    const router = new OnboardingRouter(controller);
    this.router = router.router;
    this.path = router.path;
  }
}
