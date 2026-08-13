import { Request, Response } from "express";
import { getRequestContext } from "../../middleware/request-context";
import asyncWrap from "../../utils/asyncWrapper";
import { sendSuccess } from "../../utils/send-success";
import { OrganizationService } from "./organization.service";

export class OrganizationController {
  private organizationService: OrganizationService;

  constructor(organizationService: OrganizationService) {
    this.organizationService = organizationService;
  }

  createTeam = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const { name, description, leadId, maxCaseload, caseTypeIds, memberStaffIds } = req.body;
    if (!name) return res.status(400).json({ error: "Team name is required" });
    const result = await this.organizationService.createTeam(organizationId, { name, description, leadId, maxCaseload, caseTypeIds, memberStaffIds }, req.headers as any);
    sendSuccess(res, result, "Team created successfully", 201);
  });

  getStaffMember = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const targetStaffId = req.params.staffId as string;
    const result = await this.organizationService.getStaffMember(targetStaffId, organizationId);
    if (!result) return res.status(404).json({ error: "Staff member not found" });
    sendSuccess(res, result, "Staff member retrieved successfully");
  });

  getTeam = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const teamId = req.params.teamId as string;
    const result = await this.organizationService.getTeam(teamId, organizationId);
    if (!result) return res.status(404).json({ error: "Team not found" });
    sendSuccess(res, result, "Team retrieved successfully");
  });

  getTeams = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const { search, status, page, limit } = req.query as Record<string, string | undefined>;
    const result = await this.organizationService.listTeams(organizationId, { search, status, page: page ? parseInt(page, 10) : undefined, limit: limit ? parseInt(limit, 10) : undefined });
    sendSuccess(res, result.data, "Teams retrieved successfully", 200, { pagination: result.pagination, counts: result.counts });
  });

  getStaffs = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const { search, role, team, status, page, limit } = req.query as Record<string, string | undefined>;
    const result = await this.organizationService.listStaffs(organizationId, { search, role, team, status, page: page ? parseInt(page, 10) : undefined, limit: limit ? parseInt(limit, 10) : undefined });
    sendSuccess(res, result.data, "Staff retrieved successfully", 200, { pagination: result.pagination, counts: result.counts });
  });

  invite = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!req.body) return res.status(400).json({ error: "Request body is required" });
    const { firstName, lastName, email, orgEmail, phone, role, startDate, maxCaseload, caseTypeIds, teamIds } = req.body;
    if (!firstName || !lastName || !email || !role) return res.status(400).json({ error: "firstName, lastName, email, and role are required" });
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const result = await this.organizationService.invite({ organizationId, firstName, lastName, email, orgEmail, phone, role, startDate, maxCaseload, caseTypeIds, teamIds }, req.headers as any);
    sendSuccess(res, { staffId: result.staffId }, "Invitation sent successfully", 201);
  });

  getInvitations = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const { search, role, team, status, page, limit } = req.query as Record<string, string | undefined>;
    const result = await this.organizationService.listInvitations(organizationId, { search, role, team, status, page: page ? parseInt(page, 10) : undefined, limit: limit ? parseInt(limit, 10) : undefined });
    sendSuccess(res, result.data, "Invitations retrieved successfully", 200, { pagination: result.pagination, counts: result.counts });
  });

  cancelInvitation = asyncWrap(async (req: Request, res: Response) => {
    const { invitationId } = req.body;
    if (!invitationId) return res.status(400).json({ error: "invitationId is required" });
    await this.organizationService.cancelInvite(invitationId, req.headers as any);
    sendSuccess(res, null, "Invitation cancelled");
  });

  updateStaffMember = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const targetStaffId = req.params.staffId as string;
    const { phone, jobTitle, maxCaseload, startDate, email, orgEmail, firstName, lastName, caseTypeIds, teamIds } = req.body;
    const result = await this.organizationService.updateStaffMember(targetStaffId, organizationId, { phone, jobTitle, maxCaseload, startDate, email, orgEmail, firstName, lastName, caseTypeIds, teamIds });
    sendSuccess(res, result, "Staff updated successfully");
  });

  updateStaffMemberRole = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const targetStaffId = req.params.staffId as string;
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: "role is required" });
    await this.organizationService.updateStaffMemberRole(targetStaffId, organizationId, role, req.headers as any);
    sendSuccess(res, null, "Role updated successfully");
  });

  updateStaffPortalStatus = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const targetStaffId = req.params.staffId as string;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "status is required" });
    const result = await this.organizationService.updateStaffPortalStatus(targetStaffId, organizationId, status);
    sendSuccess(res, result, "Portal status updated successfully");
  });

  removeStaffMember = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const targetStaffId = req.params.staffId as string;
    await this.organizationService.removeStaffMember(targetStaffId, organizationId);
    sendSuccess(res, null, "Staff member deleted successfully");
  });

  deleteTeam = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const teamId = req.params.teamId as string;
    await this.organizationService.deleteTeam(teamId, organizationId);
    sendSuccess(res, null, "Team deleted successfully");
  });

  removeTeamMember = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const teamId = req.params.teamId as string;
    const memberId = req.params.memberId as string;
    await this.organizationService.removeTeamMember(teamId, memberId, organizationId);
    sendSuccess(res, null, "Member removed from team");
  });

  resendInvitation = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    const { email, role } = req.body;
    if (!email || !role) return res.status(400).json({ error: "email and role are required" });
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const result = await this.organizationService.resendInvitation(email, role, organizationId, req.headers as any);
    sendSuccess(res, result, "Invitation resent successfully");
  });

  updateTeam = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const teamId = req.params.teamId as string;
    const { name, description, maxCaseload, leadId, caseTypeIds } = req.body;
    await this.organizationService.updateTeam(teamId, organizationId, { name, description, maxCaseload, leadId, caseTypeIds });
    sendSuccess(res, null, "Team updated successfully");
  });

  addTeamMembers = asyncWrap(async (req: Request, res: Response) => {
    const { organizationId } = getRequestContext();
    if (!organizationId) return res.status(400).json({ error: "No active organization" });
    const teamId = req.params.teamId as string;
    const { staffIds } = req.body;
    if (!staffIds || !Array.isArray(staffIds) || staffIds.length === 0) return res.status(400).json({ error: "staffIds array is required" });
    await this.organizationService.addTeamMembers(teamId, organizationId, staffIds);
    sendSuccess(res, null, "Members added successfully");
  });

  updateOrganization = asyncWrap(async (req: Request, res: Response) => {
    const { data: organizationData } = req.body;
    const authResponse = await this.organizationService.updateOrganization(
      organizationData,
      req,
    );
    const data = await authResponse.json();
    sendSuccess(res, data, "Organization updated successfully");
  });

  acceptInvite = asyncWrap(async (req: Request, res: Response) => {
    const { invitationId } = req.body;
    if (!invitationId)
      return res.status(400).json({ error: "invitationId is required" });
    const data = await this.organizationService.acceptInvite(
      invitationId,
      req.headers as any,
    );
    sendSuccess(res, data, "Invitation accepted");
  });

  getMyPendingInvitation = asyncWrap(async (req: Request, res: Response) => {
    const { userId } = getRequestContext();
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const invitation = await this.organizationService.getMyPendingInvitation(
      userId,
    );
    sendSuccess(res, { invitation });
  });

  needsSetup = asyncWrap(async (req: Request, res: Response) => {
    const { userId } = getRequestContext();
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const result = await this.organizationService.needsSetup(userId);
      sendSuccess(res, result);
    } catch {
      // This is a status fetch, not an error condition. Always answer 200
      // with safe defaults so the frontend can proceed.
      sendSuccess(res, { needsAcceptInvitation: false, needsPasswordChange: false });
    }
  });

  setPassword = asyncWrap(async (req: Request, res: Response) => {
    const { userId } = getRequestContext();
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res
        .status(400)
        .json({ error: "currentPassword and newPassword are required" });
    const result = await this.organizationService.setPassword(
      userId,
      { currentPassword, newPassword },
      req.headers as any,
    );
    sendSuccess(res, result, "Password set successfully");
  });
}
