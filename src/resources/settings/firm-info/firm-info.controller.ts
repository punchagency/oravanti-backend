import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { UpsertFirmInfoBody } from "../../../types/settings.types";
import { FirmInfoService } from "./firm-info.service";

export class FirmInfoController {
  private firmInfoService: FirmInfoService;

  constructor(firmInfoService: FirmInfoService) {
    this.firmInfoService = firmInfoService;
  }

  getFirmInfo = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.firmInfoService.getFirmInfo(req.firmId!);
      if (!result) {
        res.status(404).json({ message: "Firm info not set up yet" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  upsertFirmInfo = async (
    req: AuthRequest & { body: UpsertFirmInfoBody },
    res: Response,
  ) => {
    const { firmName, firmEmail } = req.body;

    if (!firmName || !firmEmail) {
      res
        .status(400)
        .json({ message: "Firm name and firm email are required" });
      return;
    }

    try {
      const result = await this.firmInfoService.upsertFirmInfo(
        req.firmId!,
        req.body,
      );
      res.status(200).json({ message: "Firm info saved", firmInfo: result });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
