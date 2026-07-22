import { fromNodeHeaders } from "better-auth/node";
import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
import { OnboardingService } from "./onboarding.service";

export class OnboardingController {
  private onboardingService: OnboardingService;

  constructor(onboardingService: OnboardingService) {
    this.onboardingService = onboardingService;
  }

  submitOnboardingData = asyncWrap(async (req: Request, res: Response) => {
    const { userId } = getRequestContext();
    const result = await this.onboardingService.submitOnboardingData(
      fromNodeHeaders(req.headers),
      userId!,
      req.body,
    );
    sendSuccess(res, result, "Onboarding data submitted successfully");
  });
}
