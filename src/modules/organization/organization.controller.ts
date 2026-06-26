import type { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { OrganizationService } from "./organization.service";

export class OrganizationController {
  private organizationService: OrganizationService;

  constructor(organizationService: OrganizationService) {
    this.organizationService = organizationService;
  }

  createTeam = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }

    const { name, description, leadId, maxCaseload, caseTypeIds, memberStaffIds } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Team name is required" });
    }

    const result = await this.organizationService.createTeam(
      req.organizationId,
      { name, description, leadId, maxCaseload, caseTypeIds, memberStaffIds },
      req.headers,
    );

    res.status(201).json(result);
  });

  getStaff = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const staffId = req.params.staffId as string;
    const result = await this.organizationService.getStaff(
      staffId,
      req.organizationId,
    );
    if (!result) {
      return res.status(404).json({ error: "Staff member not found" });
    }
    res.status(200).json(result);
  });

  getTeam = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const teamId = req.params.teamId as string;
    const result = await this.organizationService.getTeam(
      teamId,
      req.organizationId,
    );
    if (!result) {
      return res.status(404).json({ error: "Team not found" });
    }
    res.status(200).json(result);
  });

  getTeams = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }

    const { search, status, page, limit } = req.query as Record<
      string,
      string | undefined
    >;

    const result = await this.organizationService.listTeams(
      req.organizationId,
      {
        search,
        status,
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      },
    );
    res.status(200).json(result);
  });

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
      caseTypeIds,
      teamIds,
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
        caseTypeIds,
        teamIds,
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
    const { phone, jobTitle, maxCaseload, startDate, email, orgEmail, firstName, lastName, caseTypeIds, teamIds } =
      req.body;
    const result = await this.organizationService.updateStaff(
      staffId,
      req.organizationId,
      { phone, jobTitle, maxCaseload, startDate, email, orgEmail, firstName, lastName, caseTypeIds, teamIds },
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

  getMyPendingInvitation = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const invitation =
      await this.organizationService.getMyPendingInvitation(req.userId);
    res.status(200).json({ invitation });
  });

  needsSetup = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const result = await this.organizationService.needsSetup(req.userId);
    res.status(200).json(result);
  });

  deleteStaff = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const staffId = req.params.staffId as string;
    await this.organizationService.deleteStaff(staffId, req.organizationId);
    res.status(200).json({ message: "Staff deleted" });
  });

  deleteTeam = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const teamId = req.params.teamId as string;
    await this.organizationService.deleteTeam(teamId, req.organizationId);
    res.status(200).json({ message: "Team deleted" });
  });

  removeTeamMember = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const teamId = req.params.teamId as string;
    const memberId = req.params.memberId as string;
    await this.organizationService.removeTeamMember(
      teamId,
      memberId,
      req.organizationId,
    );
    res.status(200).json({ message: "Member removed from team" });
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

  updateTeam = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const teamId = req.params.teamId as string;
    const { name, description, maxCaseload, leadId, caseTypeIds } = req.body;
    await this.organizationService.updateTeam(teamId, req.organizationId, {
      name,
      description,
      maxCaseload,
      leadId,
      caseTypeIds,
    });
    res.status(200).json({ message: "Team updated" });
  });

  addTeamMembers = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const teamId = req.params.teamId as string;
    const { staffIds } = req.body;
    if (!staffIds || !Array.isArray(staffIds) || staffIds.length === 0) {
      return res.status(400).json({ error: "staffIds array is required" });
    }
    await this.organizationService.addTeamMembers(teamId, req.organizationId, staffIds);
    res.status(200).json({ message: "Members added" });
  });

  setPassword = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required" });
    }
    const result = await this.organizationService.setPassword(
      req.userId,
      { currentPassword, newPassword },
      req.headers,
    );
    res.status(200).json(result);
  });
}
