/**
 * @openapi
 * tags:
 * - name: Onboarding
 *   description: Multi-step tenant and administrator onboarding flows
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { OnboardingController } from "./onboarding.controller";

export class OnboardingRouter {
  public router: Router;
  public path: string;
  private onboardingController: OnboardingController;

  constructor(onboardingController: OnboardingController) {
    this.router = Router();
    this.path = "/onboarding";
    this.onboardingController = onboardingController;

    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.use(this.path, this.router);
    this.router.use(requireAuth);

    this.router.post(
      "/step1a-submit-domain",
      this.onboardingController.initiateDomainVerification,
    );

    this.router.post(
      "/step1b-verify-dns",
      this.onboardingController.verifyDomainDnsLive,
    );

    this.router.post(
      "/submit",
      this.onboardingController.submitOnboardingData,
    );
  }
}
