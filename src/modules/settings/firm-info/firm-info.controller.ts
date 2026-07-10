import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
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

  getFirmInfo = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.firmInfoService.getFirmInfo(req.organizationId!);
    if (!result) {
      throw new NotFoundError("Firm info not set up yet");
    }
    sendSuccess(res, result, "Firm info retrieved successfully");
  });

  upsertFirmInfo = asyncWrap(
    async (req: AuthRequest & { body: UpsertFirmInfoBody }, res: Response) => {
      const result = await this.firmInfoService.upsertFirmInfo(
        req.organizationId!,
        req.body,
      );
      sendSuccess(res, result, "Firm info saved successfully");
    },
  );
}
