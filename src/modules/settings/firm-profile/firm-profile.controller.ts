import type { Request, Response } from "express";
import { z } from "zod";
import { sendSuccess } from "../../../utils/send-success";
import { AppError } from "../../../utils/error/app-error";
import { getRequestContext } from "../../../middleware/request-context";
import { FirmProfileService } from "./firm-profile.service";

export const updateFirmProfileSchema = z.object({
  firmLegalName: z.string().trim().min(1).max(255).optional(),
  displayName: z.string().trim().max(120).optional(),
  tagline: z.string().trim().max(280).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(255).nullable().optional(),
  website: z.string().trim().url().max(2048).nullable().optional(),
  streetAddress: z.string().trim().max(255).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().max(80).nullable().optional(),
  zipCode: z.string().trim().max(20).nullable().optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  country: z.string().trim().max(120).nullable().optional(),
  barNumber: z.string().trim().max(80).nullable().optional(),
  jurisdiction: z.string().trim().max(120).nullable().optional(),
  practiceType: z.string().trim().max(80).nullable().optional(),
  foundedYear: z
    .number()
    .int()
    .min(1800)
    .max(new Date().getFullYear())
    .nullable()
    .optional(),
});

export class FirmProfileController {
  private readonly service: FirmProfileService;

  constructor(service?: FirmProfileService) {
    this.service = service ?? new FirmProfileService();
  }

  private orgId(_req: Request): string {
    const { organizationId } = getRequestContext();
    if (!organizationId) {
      throw new AppError("Organization context required", 401, "UNAUTHORIZED");
    }
    return organizationId;
  }

  getProfile = async (req: Request, res: Response) => {
    const profile = await this.service.getProfile(this.orgId(req));
    sendSuccess(res, profile, "Firm profile retrieved");
  };

  updateProfile = async (req: Request, res: Response) => {
    const parsed = updateFirmProfileSchema.parse(req.body);
    const profile = await this.service.updateProfile(this.orgId(req), parsed);
    sendSuccess(res, profile, "Firm profile updated");
  };

  getSnapshot = async (req: Request, res: Response) => {
    const snapshot = await this.service.getSnapshot(this.orgId(req));
    sendSuccess(res, snapshot, "Firm snapshot retrieved");
  };

  exportFirmData = async (req: Request, res: Response) => {
    const result = await this.service.exportFirmData(this.orgId(req));
    sendSuccess(res, result, "Firm data export generated");
  };

  deleteFirmAccount = async (req: Request, res: Response) => {
    const result = await this.service.deleteFirmAccount(this.orgId(req));
    sendSuccess(res, result, "Firm account deleted");
  };
}
