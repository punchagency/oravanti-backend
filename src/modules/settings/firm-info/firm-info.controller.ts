import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import { UpsertFirmInfoBody } from "../../../types/settings.types";
import asyncWrap from "../../../utils/asyncWrapper";
import { NotFoundError } from "../../../utils/error/app-error";
import { sendSuccess } from "../../../utils/send-success";
import { FirmInfoService } from "./firm-info.service";

export class FirmInfoController {
  private firmInfoService: FirmInfoService;

  constructor(firmInfoService: FirmInfoService) {
    this.firmInfoService = firmInfoService;
  }

  getFirmInfo = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const result = await this.firmInfoService.getFirmInfo(organizationId!);
    if (!result) {
      throw new NotFoundError("Firm info not set up yet");
    }
    sendSuccess(res, result, "Firm info retrieved successfully");
  });

  upsertFirmInfo = asyncWrap(
    async (req: Request & { body: UpsertFirmInfoBody }, res: Response) => {
      const { organizationId } = getRequestContext();
      const result = await this.firmInfoService.upsertFirmInfo(
        organizationId!,
        req.body,
      );
      sendSuccess(res, result, "Firm info saved successfully");
    },
  );
}