import { Response } from "express";
import { AuthRequest } from "../../middleware/auth.middleware";
import { sendSuccess } from "../../utils/send-success";
import { CaseReviewService } from "./case-review.service";

export class CaseReviewController {
  constructor(private readonly svc: CaseReviewService) {}

  getStats = async (req: AuthRequest, res: Response) => {
    const stats = await this.svc.getStats(req.organizationId!);
    sendSuccess(res, stats, "AI review stats retrieved");
  };

  getIssues = async (req: AuthRequest, res: Response) => {
    const { severity, status, page, limit } = req.query;
    const result = await this.svc.getIssues(req.organizationId!, {
      severity: severity as string | undefined,
      status: status as string | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    sendSuccess(res, result.data, "Issues retrieved", 200, {
      pagination: result.pagination,
    });
  };

  getIssueById = async (req: AuthRequest, res: Response) => {
    const issue = await this.svc.getIssueById(
      req.organizationId!,
      req.params.id as string,
    );
    sendSuccess(res, issue, "Issue retrieved");
  };

  updateStatus = async (req: AuthRequest, res: Response) => {
    const issue = await this.svc.updateStatus(
      req.organizationId!,
      req.params.id as string,
      req.body.action,
      req.staffId,
      req.body.note,
    );
    sendSuccess(res, issue, "Issue updated");
  };

  getConfig = async (req: AuthRequest, res: Response) => {
    const config = await this.svc.getConfig(req.organizationId!);
    sendSuccess(res, config, "Config retrieved");
  };

  updateConfig = async (req: AuthRequest, res: Response) => {
    const config = await this.svc.updateConfig(req.organizationId!, req.body);
    sendSuccess(res, config, "Config updated");
  };
}
