import { Response } from "express";
import { BadRequestError, NotFoundError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { UpdateProfileBody } from "../../../types/settings.types";
import * as profileService from "./profile.service";

export const getProfile = async (req: AuthRequest, res: Response) => {
  try {
    const result = await profileService.getProfile(req.userId!);
    if (!result) {
      throw new NotFoundError("Profile not found");
    }
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const updateProfile = async (
  req: AuthRequest & { body: UpdateProfileBody },
  res: Response,
) => {
  try {
    const result = await profileService.upsertProfile(req.userId!, req.body);
    res.status(200).json({ message: "Profile updated", profile: result });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const uploadAvatar = async (req: AuthRequest, res: Response) => {
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

  try {
    const result = await profileService.uploadAvatar(req.userId!, req.file);
    res
      .status(200)
      .json({ message: "Avatar uploaded", avatarUrl: result?.avatarUrl });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
