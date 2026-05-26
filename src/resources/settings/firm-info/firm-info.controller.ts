import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { UpsertFirmInfoBody } from "../../../types/settings.types";
import * as firmInfoService from "./firm-info.service";

export const getFirmInfo = async (req: AuthRequest, res: Response) => {
  try {
    const result = await firmInfoService.getFirmInfo(req.firmId!);
    if (!result) {
      throw new NotFoundError("Firm info not set up yet");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const upsertFirmInfo = async (
  req: AuthRequest & { body: UpsertFirmInfoBody },
  res: Response,
) => {
  const { firmName, firmEmail } = req.body;

  if (!firmName || !firmEmail) {
    throw new BadRequestError("Firm name and firm email are required");
  }

  try {
    const result = await firmInfoService.upsertFirmInfo(req.firmId!, req.body);
    res.status(200).json({ message: "Firm info saved", firmInfo: result });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
