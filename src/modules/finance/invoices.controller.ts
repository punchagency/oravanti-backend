import type { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import type { ExportFormat } from "../../utils/report-export";
import { sendSuccess } from "../../utils/send-success";
import { parsePaginationQuery } from "../../utils/pagination";
import { accessForRequest, restrictionsFor } from "./account-access";
import { getRecentActivity } from "./finance-events.service";
import * as invoicesService from "./invoices.service";
import * as paymentsService from "./payments.service";
import type { AccountFilter, InvoiceStatusFilter } from "./types";

export class InvoicesController {
  getStats = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const access = await accessForRequest();
    const stats = await invoicesService.getStats(organizationId!, access);
    sendSuccess(res, stats, "Invoice stats retrieved", 200, {
      restrictions: restrictionsFor(access),
    });
  };

  getAging = async (_req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const buckets = await invoicesService.getAging(organizationId!);
    sendSuccess(res, buckets, "Aging summary retrieved");
  };

  getActivity = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const entries = await getRecentActivity(organizationId!, limit);
    sendSuccess(res, entries, "Recent activity retrieved");
  };

  getUnbilledTime = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const entries = await invoicesService.getUnbilledTime(organizationId!, {
      clientId: req.query.clientId as string | undefined,
      caseId: req.query.caseId as string | undefined,
    });
    sendSuccess(res, entries, "Unbilled time retrieved");
  };

  list = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const access = await accessForRequest();
    const { page, limit } = parsePaginationQuery(req.query);

    const result = await invoicesService.list(organizationId!, access, {
      status: req.query.status as InvoiceStatusFilter | undefined,
      account: req.query.account as AccountFilter | undefined,
      search: req.query.search as string | undefined,
      clientId: req.query.clientId as string | undefined,
      caseId: req.query.caseId as string | undefined,
      page,
      limit,
    });

    sendSuccess(res, result.data, "Invoices retrieved", 200, {
      pagination: result.pagination,
      totals: result.totals,
      restrictions: result.restrictions,
    });
  };

  create = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const invoice = await invoicesService.create(
      organizationId!,
      staffId ?? null,
      access,
      req.body,
    );
    sendSuccess(res, invoice, "Invoice created successfully", 201);
  };

  getById = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const access = await accessForRequest();
    const invoice = await invoicesService.getById(
      organizationId!,
      req.params.id as string,
      access,
    );
    sendSuccess(res, invoice, "Invoice retrieved");
  };

  update = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const invoice = await invoicesService.update(
      organizationId!,
      req.params.id as string,
      req.body,
      staffId ?? null,
      access,
    );
    sendSuccess(res, invoice, "Invoice updated successfully");
  };

  send = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const invoice = await invoicesService.markSent(
      organizationId!,
      req.params.id as string,
      staffId ?? null,
      access,
    );
    sendSuccess(res, invoice, "Invoice sent successfully");
  };

  void = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const invoice = await invoicesService.voidInvoice(
      organizationId!,
      req.params.id as string,
      req.body?.reason,
      staffId ?? null,
      access,
    );
    sendSuccess(res, invoice, "Invoice voided successfully");
  };

  recordPayment = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const invoice = await paymentsService.recordPayment(
      organizationId!,
      req.params.id as string,
      staffId ?? null,
      access,
      req.body,
    );
    sendSuccess(res, invoice, "Payment recorded successfully", 201);
  };

  sendFollowUp = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const followup = await paymentsService.sendFollowUp(
      organizationId!,
      req.params.id as string,
      staffId ?? null,
      req.body,
    );
    sendSuccess(res, followup, "Follow-up sent successfully", 201);
  };

  export = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const access = await accessForRequest();
    const file = await invoicesService.exportInvoices(
      organizationId!,
      access,
      {
        status: req.query.status as InvoiceStatusFilter | undefined,
        account: req.query.account as AccountFilter | undefined,
        search: req.query.search as string | undefined,
      },
      (req.query.format as ExportFormat) ?? "csv",
    );
    sendDownload(res, file);
  };
}

export const sendDownload = (
  res: Response,
  file: { filename: string; mime: string; body: string | Buffer },
) => {
  res.setHeader("Content-Type", file.mime);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${file.filename}"`,
  );
  res.send(file.body);
};
