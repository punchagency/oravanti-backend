import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import * as securityService from "./security.service";
import { BadRequestError } from "../../../errors/app-error";
import { sendErrorResponse } from "../../../errors";

// ─── Change Password ──────────────────────────────────────────────────────────

export const changePassword = async (req: AuthRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    throw new BadRequestError("currentPassword and newPassword are required");
  }

  try {
    await securityService.changePassword(
      req.userId!,
      currentPassword,
      newPassword,
    );
    res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

// ─── Two-Factor Authentication ────────────────────────────────────────────────

export const get2FAStatus = async (req: AuthRequest, res: Response) => {
  try {
    const result = await securityService.get2FAStatus(req.userId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const enroll2FA = async (req: AuthRequest, res: Response) => {
  try {
    const data = await securityService.enroll2FA(req.accessToken!);
    res.status(200).json(data);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const verify2FA = async (req: AuthRequest, res: Response) => {
  const { factorId, code } = req.body;

  if (!factorId || !code) {
    throw new BadRequestError("factorId and code are required");
  }

  try {
    await securityService.verify2FA(req.accessToken!, factorId, code);
    res.status(200).json({ message: "2FA enabled successfully" });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

export const unenroll2FA = async (req: AuthRequest, res: Response) => {
  const { factorId } = req.body;

  if (!factorId) {
    throw new BadRequestError("factorId is required");
  }

  try {
    await securityService.unenroll2FA(req.accessToken!, factorId);
    res.status(200).json({ message: "2FA disabled successfully" });
  } catch (error) {
    sendErrorResponse(res, error, 400);
  }
};

// ─── Active Sessions ──────────────────────────────────────────────────────────

export const getSessions = async (req: AuthRequest, res: Response) => {
  try {
    const result = await securityService.getSessions(req.userId!);
    res.status(200).json(result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
};

export const deleteSession = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  try {
    await securityService.deleteSession(id as string, req.userId!);
    res.status(200).json({ message: "Session removed" });
  } catch (error) {
    sendErrorResponse(res, error);
  }
};
