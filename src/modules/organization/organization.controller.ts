import type { AuthRequest } from "../../middleware/auth.middleware";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
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

    sendSuccess(res, result, "Team created successfully", 201);
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
    sendSuccess(res, result, "Staff retrieved successfully");
  });

  getMyStaff = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    if (!req.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const result = await this.organizationService.getStaffByUserId(
      req.userId,
      req.organizationId,
    );
    if (!result) {
      return res.status(404).json({ error: "Staff member not found" });
    }
    sendSuccess(res, result, "Staff retrieved successfully");
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
    sendSuccess(res, result, "Team retrieved successfully");
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
    const { data, pagination, counts } = result;
    sendSuccess(res, data, "Teams retrieved successfully", 200, { pagination, counts });
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
    const { data, pagination, counts } = result;
    sendSuccess(res, data, "Staff retrieved successfully", 200, { pagination, counts });
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

    sendSuccess(res, { staffId: result.staffId, invitationId: result.invitationId }, "Invitation sent successfully", 201);
  });

  acceptInvite = asyncWrap(async (req: AuthRequest, res) => {
    const { invitationId } = req.body;
    const data = await this.organizationService.acceptInvite(
      invitationId,
      req.headers,
    );
    sendSuccess(res, data, "Invitation accepted");
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
    const { data, pagination, counts } = result;
    sendSuccess(res, data, "Invitations retrieved successfully", 200, { pagination, counts });
  });

  cancelInvitation = asyncWrap(async (req: AuthRequest, res) => {
    const { invitationId } = req.body;
    if (!invitationId) {
      return res.status(400).json({ error: "invitationId is required" });
    }
    await this.organizationService.cancelInvite(invitationId, req.headers);
    sendSuccess(res, null, "Invitation cancelled");
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
    sendSuccess(res, result, "Staff updated successfully");
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
    sendSuccess(res, null, "Role updated successfully");
  });

  getMyPendingInvitation = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const invitation =
      await this.organizationService.getMyPendingInvitation(req.userId);
    sendSuccess(res, { invitation });
  });

  needsSetup = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const result = await this.organizationService.needsSetup(req.userId);
    sendSuccess(res, result);
  });

  deleteStaff = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const staffId = req.params.staffId as string;
    await this.organizationService.deleteStaff(staffId, req.organizationId);
    sendSuccess(res, null, "Staff deleted successfully");
  });

  deleteTeam = asyncWrap(async (req: AuthRequest, res) => {
    if (!req.organizationId) {
      return res.status(400).json({ error: "No active organization" });
    }
    const teamId = req.params.teamId as string;
    await this.organizationService.deleteTeam(teamId, req.organizationId);
    sendSuccess(res, null, "Team deleted successfully");
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
    sendSuccess(res, null, "Member removed from team");
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
    sendSuccess(res, result, "Invitation resent successfully");
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
    sendSuccess(res, null, "Team updated successfully");
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
    sendSuccess(res, null, "Members added successfully");
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
    sendSuccess(res, result, "Password set successfully");
  });
}
