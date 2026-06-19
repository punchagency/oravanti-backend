import type { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { OrganizationService } from "./organization.service";

export class OrganizationController {
  private organizationService: OrganizationService;

  constructor(organizationService: OrganizationService) {
    this.organizationService = organizationService;
  }

  getAll = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }

    const { search, role, team, status, page, limit } = req.query as Record<
      string,
      string | undefined
    >;

    const result = await this.organizationService.getAll(req.organizationId, {
      search,
      role,
      team,
      status,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.status(200).json(result);
  });

  invite = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.body) {
      return res.status(400).json({ error: "Request body is required" });
    }

    console.log({ requestBody: req.body });

    const {
      firstName,
      lastName,
      email,
      orgEmail,
      phone,
      role,
      startDate,
      maxCaseload,
      practiceAreaIds,
    } = req.body;

    if (!firstName || !lastName || !email || !role) {
      return res
        .status(400)
        .json({ error: "firstName, lastName, email, and role are required" });
    }

    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }

    const result = await this.organizationService.invite(
      {
        organizationId: req.organizationId,
        firstName,
        lastName,
        email,
        orgEmail,
        phone,
        role,
        startDate,
        maxCaseload,
        practiceAreaIds,
      },
      req.headers,
    );

    return res.status(201).json({
      message: "Invitation sent successfully.",
      staffId: result.staffId,
      invitationId: result.invitationId,
    });
  });

  acceptInvite = asyncWrap(async (req: AuthRequest, res) => {
    const { invitationId } = req.body;
    const data = await this.organizationService.acceptInvite(
      invitationId,
      req.headers,
    );
    res.status(200).json({ message: "Invitation accepted", data });
  });

  getInvitations = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }

    const { search, role, team, status, page, limit } = req.query as Record<
      string,
      string | undefined
    >;

    const result = await this.organizationService.listInvitations(
      req.organizationId,
      {
        search,
        role,
        team,
        status,
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      },
    );
    res.status(200).json(result);
  });

  cancelInvitation = asyncWrap(async (req: AuthRequest, res) => {
    const { invitationId } = req.body;
    if (!invitationId) {
      return res.status(400).json({ error: "invitationId is required" });
    }
    await this.organizationService.cancelInvite(invitationId, req.headers);
    res.status(200).json({ message: "Invitation cancelled" });
  });

  updateStaff = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const staffId = req.params.staffId as string;
    const { phone, jobTitle, maxCaseload, startDate, email, orgEmail, firstName, lastName, practiceAreaIds } =
      req.body;
    const result = await this.organizationService.updateStaff(
      staffId,
      req.organizationId,
      { phone, jobTitle, maxCaseload, startDate, email, orgEmail, firstName, lastName, practiceAreaIds },
    );
    res.status(200).json(result);
  });

  updateStaffRole = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const staffId = req.params.staffId as string;
    const { role } = req.body;
    if (!role) {
      return res.status(400).json({ error: "role is required" });
    }
    await this.organizationService.updateStaffRole(
      staffId,
      req.organizationId,
      role,
      req.headers,
    );
    res.status(200).json({ message: "Role updated successfully" });
  });

  resendInvitation = asyncWrap(async (req: AuthRequest, res) => {
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: "email and role are required" });
    }
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const result = await this.organizationService.resendInvitation(
      email,
      role,
      req.organizationId,
      req.headers,
    );
    res.status(200).json({
      message: "Invitation resent successfully",
      data: result,
    });
  });
}
