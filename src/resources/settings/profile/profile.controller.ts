import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { UpdateProfileBody } from "../../../types/settings.types";
import { ProfileService } from "./profile.service";

import asyncWrap from "../../../utils/asyncWrapper";
import { BadRequestError, NotFoundError } from "../../../utils/error/app-error";

export class ProfileController {
  private profileService: ProfileService;

  constructor(profileService: ProfileService) {
    this.profileService = profileService;
  }

  getProfile = asyncWrap(async (req: AuthRequest, res: Response) => {
    
      const result = await this.profileService.getProfile(req.userId!);
      if (!result) {
        throw new NotFoundError("Profile not found");
      }
      res.status(200).json(result);
    
  });

  updateProfile = asyncWrap(async (
    req: AuthRequest & { body: UpdateProfileBody },
    res: Response,
  ) => {
    
      const result = await this.profileService.upsertProfile(
        req.userId!,
        req.body,
      );
      res.status(200).json({ message: "Profile updated", profile: result });
    
  });

  uploadAvatar = asyncWrap(async (req: AuthRequest, res: Response) => {
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
        req.userId!,
        req.file,
      );
      res
        .status(200)
        .json({ message: "Avatar uploaded", avatarUrl: result?.avatarUrl });
    
  });
}
