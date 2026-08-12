import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
import { NotificationSettingsService } from "./notification-settings.service";

export class NotificationSettingsController {
  private service: NotificationSettingsService;

  constructor(service: NotificationSettingsService) {
    this.service = service;
  }

  getSettings = asyncWrap(async (_req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.getSettings(organizationId!);
    sendSuccess(res, result, "Notification settings retrieved successfully");
  });

  updateSettings = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.updateSettings(organizationId!, req.body);
    sendSuccess(res, result, "Notification settings saved successfully");
  });
}
