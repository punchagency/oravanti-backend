import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import { sendSuccess } from "../../utils/send-success";
import { CaseReviewService } from "./case-review.service";

export class CaseReviewController {
  constructor(private readonly svc: CaseReviewService) {}

  getStats = async (_req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const stats = await this.svc.getStats(organizationId!);
    sendSuccess(res, stats, "AI review stats retrieved");
  };

  getIssues = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { severity, status, page, limit } = req.query;
    const result = await this.svc.getIssues(organizationId!, {
      severity: severity as string | undefined,
      status: status as string | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    sendSuccess(res, result.data, "Issues retrieved", 200, {
      pagination: result.pagination,
    });
  };

  getByCase = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { page, limit } = req.query;
    const result = await this.svc.getByCase(organizationId!, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    sendSuccess(res, result.data, "Matters retrieved", 200, {
      pagination: result.pagination,
    });
  };

  getByDocument = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { page, limit } = req.query;
    const result = await this.svc.getByDocument(organizationId!, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    sendSuccess(res, result.data, "Document flags retrieved", 200, {
      pagination: result.pagination,
    });
  };

  getResolutionLog = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { page, limit, days } = req.query;
    const result = await this.svc.getResolutionLog(organizationId!, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      days: days ? Number(days) : undefined,
    });
    sendSuccess(res, result.data, "Resolution log retrieved", 200, {
      pagination: result.pagination,
      summary: result.summary,
    });
  };

  exportIssues = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { severity, status } = req.query;
    const { filename, csv } = await this.svc.exportIssues(organizationId!, {
      severity: severity as string | undefined,
      status: status as string | undefined,
    });
    this.sendCsv(res, filename, csv);
  };

  exportResolutionLog = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { days } = req.query;
    const { filename, csv } = await this.svc.exportResolutionLog(
      organizationId!,
      { days: days ? Number(days) : undefined },
    );
    this.sendCsv(res, filename, csv);
  };

  private sendCsv = (res: Response, filename: string, csv: string) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.send(csv);
  };

  runAction = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const result = await this.svc.runAction(
      organizationId!,
      req.params.id as string,
      req.params.actionKey as string,
      staffId ?? undefined,
    );
    sendSuccess(res, result, "Action performed");
  };

  getIssueById = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const issue = await this.svc.getIssueById(
      organizationId!,
      req.params.id as string,
    );
    sendSuccess(res, issue, "Issue retrieved");
  };

  updateStatus = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const issue = await this.svc.updateStatus(
      organizationId!,
      req.params.id as string,
      req.body.action,
      staffId ?? undefined,
      req.body.note,
    );
    sendSuccess(res, issue, "Issue updated");
  };

  getConfig = async (_req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const config = await this.svc.getConfig(organizationId!);
    sendSuccess(res, config, "Config retrieved");
  };

  updateConfig = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const config = await this.svc.updateConfig(organizationId!, req.body);
    sendSuccess(res, config, "Config updated");
  };
}
