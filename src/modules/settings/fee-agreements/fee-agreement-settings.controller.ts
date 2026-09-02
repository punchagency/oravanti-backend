import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import asyncWrap from "../../../utils/asyncWrapper";
import { sendSuccess } from "../../../utils/send-success";
import { FeeAgreementSettingsService } from "./fee-agreement-settings.service";

export class FeeAgreementSettingsController {
  private service: FeeAgreementSettingsService;

  constructor(service: FeeAgreementSettingsService) {
    this.service = service;
  }

  getSettings = asyncWrap(async (_req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.getSettings(organizationId!);
    sendSuccess(res, result, "Fee agreement settings retrieved successfully");
  });

  upsertSettings = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.upsertSettings(organizationId!, req.body);
    sendSuccess(res, result, "Fee agreement settings saved successfully");
  });

  listEligibleSigners = asyncWrap(async (_req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.service.listEligibleSigners(organizationId!);
    sendSuccess(res, result, "Eligible signers retrieved successfully");
  });
}
