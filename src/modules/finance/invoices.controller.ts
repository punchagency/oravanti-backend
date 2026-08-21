import type { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import type { ExportFormat } from "../../utils/report-export";
import { sendSuccess } from "../../utils/send-success";
import { parsePaginationQuery } from "../../utils/pagination";
import { accessForRequest, restrictionsFor } from "./account-access";
import { recordAccessEvent } from "../shared/audit.service";
import {
  buildInvoicePdf,
  listDeliveries,
  resendInvoice,
  sendInvoice,
} from "./deliveries.service";
import { getRecentActivity } from "./finance-events.service";
import * as instalmentsService from "./instalments.service";
import { listPresets, saveFirmPreset } from "./line-presets.service";
import * as invoicesService from "./invoices.service";
import * as paymentsService from "./payments.service";
import * as refundsService from "./refunds.service";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { consultations } from "../../db/schema/consultations";
import { BadRequestError } from "../../utils/error/app-error";
import { settleConsultationForInvoice } from "../leads/leads.service";
import { createModuleLogger } from "../../lib/logging/log";
import type { AccountFilter, InvoiceStatusFilter } from "./types";

const log = createModuleLogger("invoices.controller");

/**
 * Refuse to reverse or withdraw a consultation fee from the Finance screen.
 *
 * Cancelling the consultation already does this properly: it refunds what was
 * paid, releases the calendar slot, revokes the booking link and tells the
 * client. Refunding the invoice on its own does none of that, so the
 * consultation stays scheduled, the Meet link keeps working, and the client
 * arrives for a call the firm believes it refunded.
 *
 * Guarded HERE and not in the service on purpose: `cancelConsultation` reaches
 * `refundInvoiceInFull` -> `refundPayment` internally and must keep working.
 * The controller is the only layer where "a human clicked this in Finance" is
 * actually true.
 */
const refuseIfConsultationFee = async (
  organizationId: string,
  invoiceId: string,
  verb: string,
): Promise<void> => {
  const [consultation] = await db
    .select({ id: consultations.id })
    .from(consultations)
    .where(
      and(
        eq(consultations.organizationId, organizationId),
        eq(consultations.invoiceId, invoiceId),
      ),
    )
    .limit(1);

  if (consultation) {
    throw new BadRequestError(
      `This invoice is for a consultation, so it cannot be ${verb} from here. Cancel the consultation instead — that refunds the client, releases the calendar slot and notifies them in one step.`,
    );
  }
};

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
      forInvoiceId: req.query.forInvoiceId as string | undefined,
    });
    sendSuccess(res, entries, "Unbilled time retrieved");
  };

  getCaseDefaults = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const defaults = await invoicesService.getCaseDefaults(
      organizationId!,
      req.query.caseId as string,
    );
    sendSuccess(res, defaults, "Matter defaults retrieved");
  };

  getLinePresets = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const access = await accessForRequest();
    const presets = await listPresets(organizationId!, access, {
      practiceAreaId: req.query.practiceAreaId as string | undefined,
      caseTypeId: req.query.caseTypeId as string | undefined,
      account: req.query.account as
        | "operating"
        | "trust_iolta"
        | undefined,
    });
    sendSuccess(res, presets, "Line presets retrieved", 200, {
      restrictions: restrictionsFor(access),
    });
  };

  createLinePreset = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const preset = await saveFirmPreset(
      organizationId!,
      staffId ?? null,
      access,
      req.body,
    );
    sendSuccess(res, preset, "Line preset saved", 201);
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
      // validateRequest replaces req.query with the parsed object, so this is a
      // real boolean by now — Express's own typing just cannot see that.
      includeDrafts: (req.query.includeDrafts as unknown as boolean) === true,
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

  setSchedule = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const { notification } = await instalmentsService.setSchedule(
      organizationId!,
      req.params.id as string,
      req.body.instalments,
      staffId ?? null,
      access,
    );
    const invoice = await invoicesService.getById(
      organizationId!,
      req.params.id as string,
      access,
    );
    // The schedule is saved either way; the message says whether the client was
    // actually told, rather than letting a silent failure read as success.
    sendSuccess(
      res,
      { ...invoice, notification },
      notification === null
        ? "Payment schedule saved"
        : notification.status === "sent"
          ? `Payment schedule saved and sent to ${notification.recipientEmail}`
          : "Payment schedule saved, but the client could not be notified",
    );
  };

  removeSchedule = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    await instalmentsService.removeSchedule(
      organizationId!,
      req.params.id as string,
      staffId ?? null,
    );
    const invoice = await invoicesService.getById(
      organizationId!,
      req.params.id as string,
      access,
    );
    sendSuccess(res, invoice, "Payment schedule removed");
  };

  /**
   * A failed send is a 201 with `status: "failed"`, not an error status: the
   * attempt was recorded and the caller needs the reason to act on. Only an
   * unusable request (void invoice, no client email) throws.
   */
  send = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const result = await sendInvoice(
      organizationId!,
      req.params.id as string,
      staffId ?? null,
      access,
    );
    sendSuccess(
      res,
      result,
      result.status === "sent"
        ? "Invoice sent to the client"
        : "Invoice could not be delivered — the attempt was recorded",
      201,
    );
  };

  resend = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const result = await resendInvoice(
      organizationId!,
      req.params.id as string,
      staffId ?? null,
      access,
    );
    sendSuccess(
      res,
      result,
      result.status === "sent"
        ? "Invoice resent to the client"
        : "Invoice could not be delivered — the attempt was recorded",
      201,
    );
  };

  getDeliveries = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const rows = await listDeliveries(organizationId!, req.params.id as string);
    sendSuccess(res, rows, "Deliveries retrieved");
  };

  /** The only invoice renderer — the frontend no longer builds its own HTML. */
  pdf = async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const access = await accessForRequest();
    const invoiceId = req.params.id as string;
    const { buffer, invoiceNumber } = await buildInvoicePdf(
      organizationId!,
      invoiceId,
      access,
    );
    await recordAccessEvent({ action: "invoice.downloaded", entityId: invoiceId, dedupeWindowMs: 0 });
    sendDownload(res, {
      filename: `${invoiceNumber}.pdf`,
      mime: "application/pdf",
      body: buffer,
    });
  };

  void = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    // Closed for the same reason as the refund above. Leaving void open while
    // closing refund would keep the stranded-consultation bug alive through the
    // other door: voiding the fee invoice used to leave the lead on a booking
    // page that would never offer a slot.
    await refuseIfConsultationFee(
      organizationId!,
      req.params.id as string,
      "voided",
    );
    const invoice = await invoicesService.voidInvoice(
      organizationId!,
      req.params.id as string,
      req.body?.reason,
      staffId ?? null,
      access,
    );
    sendSuccess(res, invoice, "Invoice voided successfully");
  };

  extendDueDate = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    const invoice = await invoicesService.extendDueDate(
      organizationId!,
      req.params.id as string,
      req.body,
      staffId ?? null,
      access,
    );
    sendSuccess(res, invoice, "Due date extended");
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

    // A consultation fee settled by hand moves the consultation on, exactly as
    // a Confido payment does. Until now `settleConsultationForInvoice` had a
    // single caller — the webhook — so `pay_in_person`, the one timing that is
    // ALWAYS recorded manually, was the one flow with no automation behind it:
    // staff had to record the payment and then separately PATCH the fee status.
    //
    // Called here rather than inside `recordPayment` so the webhook, which
    // already calls it, does not fire it twice and race its own confirmation
    // email. Non-fatal for the same reason as the webhook's call: the money is
    // recorded, and a consultation that fails to advance is recoverable.
    await settleConsultationForInvoice(
      organizationId!,
      req.params.id as string,
    ).catch((err) =>
      log.failure("leads.consultation_settle_failed", err, {
        invoiceId: req.params.id,
      }),
    );

    sendSuccess(res, invoice, "Payment recorded successfully", 201);
  };

  refundPayment = async (req: Request, res: Response) => {
    const { organizationId, staffId } = getRequestContext();
    const access = await accessForRequest();
    await refuseIfConsultationFee(
      organizationId!,
      req.params.id as string,
      "refunded",
    );
    const result = await refundsService.refundPayment(
      organizationId!,
      req.params.id as string,
      req.params.paymentId as string,
      staffId ?? null,
      access,
      req.body,
    );
    sendSuccess(
      res,
      result,
      result.executedAs.toLowerCase().includes("void")
        ? "Payment voided before it settled"
        : "Refund issued",
      201,
    );
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
