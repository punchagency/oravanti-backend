import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { getRevenueAnalytics, Period } from "./revenue-analytics.service";

const VALID_PERIODS: Period[] = ["month", "quarter", "year", "all"];

export const getAnalytics = async (req: AuthRequest, res: Response) => {
  const period = (req.query.period as Period) ?? "month";
  const teamId = req.query.teamId as string | undefined;

  if (!VALID_PERIODS.includes(period)) {
    res
      .status(400)
      .json({ message: "Invalid period. Use: month, quarter, year, all" });
    return;
  }

  const data = await getRevenueAnalytics(req.firmId!, period, teamId);
  res.json(data);
};

export const exportReport = async (req: AuthRequest, res: Response) => {
  const period = (req.query.period as Period) ?? "month";
  const teamId = req.query.teamId as string | undefined;

  if (!VALID_PERIODS.includes(period)) {
    res
      .status(400)
      .json({ message: "Invalid period. Use: month, quarter, year, all" });
    return;
  }

  const data = await getRevenueAnalytics(req.firmId!, period, teamId);

  res.json({
    exportedAt: new Date().toISOString(),
    ...data,
  });
};
