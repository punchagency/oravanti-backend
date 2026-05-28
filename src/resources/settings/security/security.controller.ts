import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
import { BadRequestError } from "../../../utils/error/app-error";
import { SecurityService } from "./security.service";

export class SecurityController {
  private securityService: SecurityService;

  constructor(securityService: SecurityService) {
    this.securityService = securityService;
  }

  // ─── Change Password ──────────────────────────────────────────────────────────

  changePassword = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      throw new BadRequestError("currentPassword and newPassword are required");
    }

    await this.securityService.changePassword(
      req.userId!,
      currentPassword,
      newPassword,
    );
    res.status(200).json({ message: "Password updated successfully" });
  });

  // ─── Two-Factor Authentication ────────────────────────────────────────────────

  get2FAStatus = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.securityService.get2FAStatus(req.userId!);
    res.status(200).json(result);
  });

  enroll2FA = asyncWrap(async (req: AuthRequest, res: Response) => {
    const data = await this.securityService.enroll2FA(req.accessToken!);
    res.status(200).json(data);
  });

  verify2FA = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { factorId, code } = req.body;

    if (!factorId || !code) {
      throw new BadRequestError("factorId and code are required");
    }

    await this.securityService.verify2FA(req.accessToken!, factorId, code);
    res.status(200).json({ message: "2FA enabled successfully" });
  });

  unenroll2FA = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { factorId } = req.body;

    if (!factorId) {
      throw new BadRequestError("factorId is required");
    }

    await this.securityService.unenroll2FA(req.accessToken!, factorId);
    res.status(200).json({ message: "2FA disabled successfully" });
  });

  // ─── Active Sessions ──────────────────────────────────────────────────────────

  getSessions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.securityService.getSessions(req.userId!);
    res.status(200).json(result);
  });

  deleteSession = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    await this.securityService.deleteSession(id as string, req.userId!);
    res.status(200).json({ message: "Session removed" });
  });
}
