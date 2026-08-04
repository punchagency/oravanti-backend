import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
import { StaffsService } from "./staffs.service";

export class StaffsController {
  private staffsService: StaffsService;

  constructor(staffsService: StaffsService) {
    this.staffsService = staffsService;
  }

  getOwnProfile = asyncWrap(async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!organizationId)
      return res.status(400).json({ error: "No active organization" });
    const result = await this.staffsService.getOwnProfile(
      userId,
      organizationId,
    );
    if (!result)
      return res.status(404).json({ error: "Staff member not found" });
    sendSuccess(res, result, "Profile retrieved successfully");
  });

  updateOwnProfile = asyncWrap(async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!organizationId)
      return res.status(400).json({ error: "No active organization" });
    const result = await this.staffsService.updateOwnProfile(
      userId,
      organizationId,
      req.body,
    );
    sendSuccess(res, result, "Profile updated successfully");
  });

  uploadAvatar = asyncWrap(async (req: Request, res: Response) => {
    const { staffId, organizationId } = getRequestContext();
    if (!staffId) return res.status(401).json({ error: "Unauthorized" });
    if (!organizationId)
      return res.status(400).json({ error: "No active organization" });

    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const result = await this.staffsService.uploadAvatar(
      staffId,
      organizationId,
      {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      },
    );
    if (!result)
      return res.status(404).json({ error: "Staff member not found" });
    sendSuccess(res, {}, "Avatar uploaded successfully");
  });
}
