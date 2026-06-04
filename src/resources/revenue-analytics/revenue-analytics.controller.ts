import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { Period, RevenueAnalyticsService } from "./revenue-analytics.service";

export class RevenueAnalyticsController {
  private revenueAnalyticsService: RevenueAnalyticsService;

  constructor(revenueAnalyticsService: RevenueAnalyticsService) {
    this.revenueAnalyticsService = revenueAnalyticsService;
  }

  getAnalytics = asyncWrap(async (req: AuthRequest, res: Response) => {
    const period = (req.query.period as Period) ?? "month";
    const teamId = req.query.teamId as string | undefined;

    const data = await this.revenueAnalyticsService.getRevenueAnalytics(
      req.organizationId!,
      period,
      teamId,
    );
    res.json(data);
  });

  exportReport = asyncWrap(async (req: AuthRequest, res: Response) => {
    const period = (req.query.period as Period) ?? "month";
    const teamId = req.query.teamId as string | undefined;

    const data = await this.revenueAnalyticsService.getRevenueAnalytics(
      req.organizationId!,
      period,
      teamId,
    );

    res.json({
      exportedAt: new Date().toISOString(),
      ...data,
    });
  });
}
