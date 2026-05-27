import { Response } from "express";
import { AuthRequest } from "../../../middleware/auth.middleware";
import { SecurityService } from "./security.service";

export class SecurityController {
  private securityService: SecurityService;

  constructor(securityService: SecurityService) {
    this.securityService = securityService;
  }

  // ─── Change Password ──────────────────────────────────────────────────────────

  changePassword = async (req: AuthRequest, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res
        .status(400)
        .json({ message: "currentPassword and newPassword are required" });
      return;
    }

    try {
      await this.securityService.changePassword(
        req.userId!,
        currentPassword,
        newPassword,
      );
      res.status(200).json({ message: "Password updated successfully" });
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  // ─── Two-Factor Authentication ────────────────────────────────────────────────

  get2FAStatus = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.securityService.get2FAStatus(req.userId!);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  enroll2FA = async (req: AuthRequest, res: Response) => {
    try {
      const data = await this.securityService.enroll2FA(req.accessToken!);
      res.status(200).json(data);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  verify2FA = async (req: AuthRequest, res: Response) => {
    const { factorId, code } = req.body;

    if (!factorId || !code) {
      res.status(400).json({ message: "factorId and code are required" });
      return;
    }

    try {
      await this.securityService.verify2FA(req.accessToken!, factorId, code);
      res.status(200).json({ message: "2FA enabled successfully" });
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  unenroll2FA = async (req: AuthRequest, res: Response) => {
    const { factorId } = req.body;

    if (!factorId) {
      res.status(400).json({ message: "factorId is required" });
      return;
    }

    try {
      await this.securityService.unenroll2FA(req.accessToken!, factorId);
      res.status(200).json({ message: "2FA disabled successfully" });
    } catch (error) {
      res.status(400).json({ message: (error as Error).message });
    }
  };

  // ─── Active Sessions ──────────────────────────────────────────────────────────

  getSessions = async (req: AuthRequest, res: Response) => {
    try {
      const result = await this.securityService.getSessions(req.userId!);
      res.status(200).json(result);
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };

  deleteSession = async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    try {
      await this.securityService.deleteSession(id as string, req.userId!);
      res.status(200).json({ message: "Session removed" });
    } catch (error) {
      res.status(500).json({ message: (error as Error).message });
    }
  };
}
