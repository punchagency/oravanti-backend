import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { parsePositiveIntegerQuery } from "../../utils/pagination";
import { sendSuccess } from "../../utils/send-success";
import {
  deliveryTrackingStatus,
  NotificationsService,
} from "./notifications.service";

export class NotificationsController {
  private service: NotificationsService;

  constructor(service: NotificationsService) {
    this.service = service;
  }

  list = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();

    const page = parsePositiveIntegerQuery(req.query.page, "page", 1);
    const limit = parsePositiveIntegerQuery(req.query.limit, "limit", 20);

    const result = await this.service.list(
      organizationId!,
      {
        leadId: req.query.leadId as string | undefined,
        clientId: req.query.clientId as string | undefined,
        invoiceId: req.query.invoiceId as string | undefined,
        caseId: req.query.caseId as string | undefined,
      },
      { page, limit },
    );

    sendSuccess(res, result, "Notifications retrieved successfully");
  });

  /**
   * What the deployment can actually confirm. Lets the UI say "delivery
   * tracking unavailable" rather than showing every email apparently stuck at
   * "sent".
   */
  capabilities = asyncWrap(async (_req: Request, res: Response) => {
    sendSuccess(
      res,
      { deliveryTracking: deliveryTrackingStatus() },
      "Notification capabilities retrieved successfully",
    );
  });
}
