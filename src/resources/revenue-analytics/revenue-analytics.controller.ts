import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { Period, RevenueAnalyticsService } from "./revenue-analytics.service";

import asyncWrap from "../../utils/asyncWrapper";
import { BadRequestError } from "../../utils/error/app-error";

const VALID_PERIODS: Period[] = ["month", "quarter", "year", "all"];

export class RevenueAnalyticsController {
  private revenueAnalyticsService: RevenueAnalyticsService;

  constructor(revenueAnalyticsService: RevenueAnalyticsService) {
    this.revenueAnalyticsService = revenueAnalyticsService;
  }

  getAnalytics = asyncWrap(async (req: AuthRequest, res: Response) => {
    const period = (req.query.period as Period) ?? "month";
    const teamId = req.query.teamId as string | undefined;

    if (!VALID_PERIODS.includes(period)) {
      throw new BadRequestError("Invalid period. Use: month, quarter, year, all");
    }

    const data = await this.revenueAnalyticsService.getRevenueAnalytics(
      req.firmId!,
      period,
      teamId,
    );
    res.json(data);
  });

  exportReport = asyncWrap(async (req: AuthRequest, res: Response) => {
    const period = (req.query.period as Period) ?? "month";
    const teamId = req.query.teamId as string | undefined;

    if (!VALID_PERIODS.includes(period)) {
      throw new BadRequestError("Invalid period. Use: month, quarter, year, all");
    }

    const data = await this.revenueAnalyticsService.getRevenueAnalytics(
      req.firmId!,
      period,
      teamId,
    );

    res.json({
      exportedAt: new Date().toISOString(),
      ...data,
    });
  });
}
