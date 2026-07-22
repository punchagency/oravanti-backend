import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
import { Period, RevenueAnalyticsService } from "./revenue-analytics.service";

export class RevenueAnalyticsController {
  private revenueAnalyticsService: RevenueAnalyticsService;

  constructor(revenueAnalyticsService: RevenueAnalyticsService) {
    this.revenueAnalyticsService = revenueAnalyticsService;
  }

  getAnalytics = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const period = (req.query.period as Period) ?? "month";
    const teamId = req.query.teamId as string | undefined;

    const data = await this.revenueAnalyticsService.getRevenueAnalytics(
      organizationId!,
      period,
      teamId,
    );
    sendSuccess(res, data, "Revenue analytics retrieved successfully");
  });

  exportReport = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    const period = (req.query.period as Period) ?? "month";
    const teamId = req.query.teamId as string | undefined;

    const data = await this.revenueAnalyticsService.getRevenueAnalytics(
      organizationId!,
      period,
      teamId,
    );

    sendSuccess(res, { exportedAt: new Date().toISOString(), ...data }, "Report exported successfully");
  });
}
