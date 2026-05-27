import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { Period, RevenueAnalyticsService } from "./revenue-analytics.service";

const VALID_PERIODS: Period[] = ["month", "quarter", "year", "all"];

export class RevenueAnalyticsController {
  private revenueAnalyticsService: RevenueAnalyticsService;

  constructor(revenueAnalyticsService: RevenueAnalyticsService) {
    this.revenueAnalyticsService = revenueAnalyticsService;
  }

  getAnalytics = async (req: AuthRequest, res: Response) => {
    const period = (req.query.period as Period) ?? "month";
    const teamId = req.query.teamId as string | undefined;

    if (!VALID_PERIODS.includes(period)) {
      res
        .status(400)
        .json({ message: "Invalid period. Use: month, quarter, year, all" });
      return;
    }

    const data = await this.revenueAnalyticsService.getRevenueAnalytics(
      req.firmId!,
      period,
      teamId,
    );
    res.json(data);
  };

  exportReport = async (req: AuthRequest, res: Response) => {
    const period = (req.query.period as Period) ?? "month";
    const teamId = req.query.teamId as string | undefined;

    if (!VALID_PERIODS.includes(period)) {
      res
        .status(400)
        .json({ message: "Invalid period. Use: month, quarter, year, all" });
      return;
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
  };
}
