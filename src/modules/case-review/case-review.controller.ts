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
