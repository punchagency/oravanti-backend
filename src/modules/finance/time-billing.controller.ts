import type { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import type { ExportFormat } from "../../utils/report-export";
import { parsePaginationQuery } from "../../utils/pagination";
import { sendSuccess } from "../../utils/send-success";
import {
  listBillingRates,
  setBillingRate,
} from "./billing-rates.service";
import { sendDownload } from "./invoices.controller";
import * as service from "./time-billing.service";
import type { TimeEntryStatusFilter } from "./time-billing.service";

const period = (req: Request) => ({
  from: req.query.from as string | undefined,
  to: req.query.to as string | undefined,
});

export class TimeBillingController {
  getStats = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const stats = await service.getStats(organizationId!, period(req));
    sendSuccess(res, stats, "Time & billing stats retrieved");
  };

  getEarningsByStaff = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const rows = await service.getEarningsByStaff(organizationId!, period(req));
    sendSuccess(res, rows, "Earnings by staff retrieved");
  };

  getTopMatters = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await service.getTopMatters(
      organizationId!,
      period(req),
      req.query.limit ? Number(req.query.limit) : undefined,
    );
    sendSuccess(res, result, "Top matters retrieved");
  };

  list = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { page, limit } = parsePaginationQuery(req.query);
    const result = await service.list(organizationId!, {
      status: req.query.status as TimeEntryStatusFilter | undefined,
      staffId: req.query.staffId as string | undefined,
      caseId: req.query.caseId as string | undefined,
      ...period(req),
      page,
      limit,
    });
    sendSuccess(res, result.data, "Time entries retrieved", 200, {
      pagination: result.pagination,
      totals: result.totals,
    });
  };

  create = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    // Logging on someone else's behalf is a supervisory act, so it is gated on
    // the same permission that approves time.
    const canApprove = await hasApproveTime(req);
    const entry = await service.create(
      organizationId!,
      staffId ?? null,
      canApprove,
      req.body,
    );
    sendSuccess(res, entry, "Time entry logged successfully", 201);
  };

  update = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const entry = await service.update(
      organizationId!,
      req.params.id as string,
      req.body,
    );
    sendSuccess(res, entry, "Time entry updated successfully");
  };

  approve = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const entry = await service.approve(
      organizationId!,
      req.params.id as string,
      staffId ?? null,
    );
    sendSuccess(res, entry, "Time entry approved successfully");
  };

  reject = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const entry = await service.reject(
      organizationId!,
      req.params.id as string,
      req.body.reason,
      staffId ?? null,
    );
    sendSuccess(res, entry, "Time entry rejected");
  };

  listRates = async (_req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const rates = await listBillingRates(organizationId!);
    sendSuccess(res, rates, "Billing rates retrieved");
  };

  setRate = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const rate = await setBillingRate({
      organizationId: organizationId!,
      staffId: req.body.staffId ?? null,
      role: req.body.role ?? null,
      rate: req.body.rate,
      effectiveFrom: req.body.effectiveFrom,
      createdById: staffId ?? null,
    });
    sendSuccess(res, rate, "Billing rate set successfully", 201);
  };

  export = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const file = await service.exportTimeEntries(
      organizationId!,
      {
        status: req.query.status as TimeEntryStatusFilter | undefined,
        staffId: req.query.staffId as string | undefined,
        ...period(req),
      },
      (req.query.format as ExportFormat) ?? "csv",
    );
    sendDownload(res, file);
  };
}

/**
 * Whether the caller may act on other people's time.
 *
 * Checked here rather than as a route guard because the answer only changes
 * what the request is *allowed to contain* (a staffId other than one's own),
 * not whether the route may be reached at all.
 */
const hasApproveTime = async (req: Request): Promise<boolean> => {
  const { fromNodeHeaders } = await import("better-auth/node");
  const { auth } = await import("../../auth");
  const { organizationId } = getRequestContext();
  if (!organizationId) return false;

  try {
    const result = await auth.api.hasPermission({
      body: {
        organizationId,
        permissions: { finance: ["approve_time"] } as Record<string, string[]>,
      },
      headers: fromNodeHeaders(req.headers as Record<string, string>),
    });
    return Boolean(result.success);
  } catch {
    return false;
  }
};
