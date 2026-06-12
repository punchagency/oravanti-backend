import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { UpsertFirmInfoBody } from "../../../types/settings.types";
import asyncWrap from "../../../utils/asyncWrapper";
import { NotFoundError } from "../../../utils/error/app-error";
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
    res.status(200).json(result);
  });

  upsertFirmInfo = asyncWrap(
    async (req: AuthRequest & { body: UpsertFirmInfoBody }, res: Response) => {
      const result = await this.firmInfoService.upsertFirmInfo(
        req.organizationId!,
        req.body,
      );
      res.status(200).json({ message: "Firm info saved", firmInfo: result });
    },
  );
}
