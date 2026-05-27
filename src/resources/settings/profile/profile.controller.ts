import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { UpdateProfileBody } from "../../../types/settings.types";
import { ProfileService } from "./profile.service";

export class ProfileController {
  private profileService: ProfileService;

  constructor(profileService: ProfileService) {
    this.profileService = profileService;
  }

  getProfile = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.profileService.getProfile(req.userId!);
      if (!result) {
        res.status(404).json({ message: "Profile not found" });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  updateProfile = async (
    req: AuthRequest & { body: UpdateProfileBody },
    res: Response,
  ) => {
    try {
      const result = await this.profileService.upsertProfile(
        req.userId!,
        req.body,
      );
      res.status(200).json({ message: "Profile updated", profile: result });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  uploadAvatar = async (req: AuthRequest, res: Response) => {
    if (!req.file) {
      res.status(400).json({ message: "No file uploaded" });
      return;
    }

    const allowedTypes = ["image/jpeg", "image/png", "image/gif"];
    if (!allowedTypes.includes(req.file.mimetype)) {
      res
        .status(400)
        .json({ message: "Only JPG, PNG or GIF files are allowed" });
      return;
    }

    if (req.file.size > 2 * 1024 * 1024) {
      res.status(400).json({ message: "File size must be under 2MB" });
      return;
    }

    try {
      const result = await this.profileService.uploadAvatar(
        req.userId!,
        req.file,
      );
      res
        .status(200)
        .json({ message: "Avatar uploaded", avatarUrl: result?.avatarUrl });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
