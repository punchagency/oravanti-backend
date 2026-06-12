import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import asyncWrap from "../../../utils/asyncWrapper";
import { SecurityService } from "./security.service";

export class SecurityController {
  private securityService: SecurityService;

  constructor(securityService: SecurityService) {
    this.securityService = securityService;
  }

  // ─── Change Password ──────────────────────────────────────────────────────────

  changePassword = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    await this.securityService.changePassword(
      req,
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
    const { password } = req.body;

    const data = await this.securityService.enroll2FA(req, password);
    res.status(200).json(data);
  });

  verify2FA = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { code } = req.body;

    await this.securityService.verify2FA(req, code);
    res.status(200).json({ message: "2FA enabled successfully" });
  });

  unenroll2FA = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { password } = req.body;

    await this.securityService.unenroll2FA(req, password);
    res.status(200).json({ message: "2FA disabled successfully" });
  });

  // ─── Active Sessions ──────────────────────────────────────────────────────────

  getSessions = asyncWrap(async (req: AuthRequest, res: Response) => {
    const result = await this.securityService.getSessions(req);
    res.status(200).json(result);
  });

  deleteSession = asyncWrap(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    await this.securityService.deleteSession(req, id as string);
    res.status(200).json({ message: "Session removed" });
  });
}
