import type { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import type { ExportFormat } from "../../utils/report-export";
import { sendSuccess } from "../../utils/send-success";
import { accessForRequest } from "./account-access";
import { sendDownload } from "./invoices.controller";
import * as service from "./reports.service";

export class FinanceReportsController {
  getReport = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const access = await accessForRequest();
    const report = await service.getMonthlyReport(
      organizationId!,
      access,
      req.query.month as string | undefined,
    );
    sendSuccess(res, report, "Financial report retrieved");
  };

  export = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const access = await accessForRequest();
    const file = await service.exportReport(
      organizationId!,
      access,
      req.query.month as string | undefined,
      (req.query.format as ExportFormat) ?? "csv",
    );
    sendDownload(res, file);
  };
}
