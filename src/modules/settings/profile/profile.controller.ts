import { Request, Response } from "express";
import { getRequestContext } from "../../../middleware/request-context";
import { UpdateProfileBody } from "../../../types/settings.types";
import asyncWrap from "../../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../../utils/error/app-error";
import { sendSuccess } from "../../../utils/send-success";
import { ProfileService } from "./profile.service";

export class ProfileController {
  private profileService: ProfileService;

  constructor(profileService: ProfileService) {
    this.profileService = profileService;
  }

  getProfile = asyncWrap(async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
    const result = await this.profileService.getProfile(userId!);
    if (!result) {
      throw new NotFoundError("Profile not found");
    }
    sendSuccess(res, result, "Profile retrieved successfully");
  });

  updateProfile = asyncWrap(
    async (req: Request & { body: UpdateProfileBody }, res: Response) => {
      const { userId } = getRequestContext();
      const result = await this.profileService.upsertProfile(
        userId!,
        req.body,
      );
      sendSuccess(res, result, "Profile updated successfully");
    },
  );

  uploadAvatar = asyncWrap(async (req: Request, res: Response) => {
    const { userId, organizationId } = getRequestContext();
    if (!req.file) {
      throw new BadRequestError("No file uploaded");
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/gif"];
    if (!allowedTypes.includes(req.file.mimetype)) {
      throw new BadRequestError("Only JPG, PNG or GIF files are allowed");
    }

    if (req.file.size > 2 * 1024 * 1024) {
      throw new BadRequestError("File size must be under 2MB");
    }

    const result = await this.profileService.uploadAvatar(
      userId!,
      req.file,
    );
    sendSuccess(res, result, "Avatar uploaded successfully");
  });
}