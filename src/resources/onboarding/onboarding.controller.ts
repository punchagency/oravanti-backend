import { fromNodeHeaders } from "better-auth/node";
import { Request, Response } from "express";
import asyncWrap from "../../utils/asyncWrapper";
import { OnboardingService } from "./onboarding.service";

export class OnboardingController {
  private onboardingService: OnboardingService;

  constructor(onboardingService: OnboardingService) {
    this.onboardingService = onboardingService;
  }

  initiateDomainVerification = asyncWrap(
    async (req: Request, res: Response) => {
      const result = await this.onboardingService.initiateDomainVerification(
        fromNodeHeaders(req.headers),
        (req as any).userId,
        req.body.domain,
      );
      res.json(result);
    },
  );

  verifyDomainDnsLive = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.onboardingService.verifyDomainDnsLive(
      (req as any).userId,
      req.body.organizationId,
    );
    res.json(result);
  });

  submitOnboardingData = asyncWrap(async (req: Request, res: Response) => {
    const result = await this.onboardingService.submitOnboardingData(
      (req as any).userId,
      req.body,
    );
    res.json(result);
  });
}
