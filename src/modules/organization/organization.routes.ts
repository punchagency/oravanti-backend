/**
 * @openapi
 * tags:
 *   - name: Organization
 *     description: Organization invitations & membership
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { OrganizationController } from "./organization.controller";

export class OrganizationRouter {
  public router: Router;
  public path: string;
  private organizationController: OrganizationController;

  constructor(organizationController: OrganizationController) {
    this.organizationController = organizationController;
    this.router = Router();
    this.path = "/organization";

    this.initializeRoutes();
  }

  initializeRoutes() {
    /**
     * @openapi
     * /organization/invite:
     *   post:
     *     tags: [Organization]
     *     summary: Invite a user to the organization
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/OrganizationInviteRequest"
     *     responses:
     *       201:
     *         description: Invitation sent
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     *       400: { description: Validation error }
     */
    this.router.get(
      "/teams",
      requireAuth,
      requirePermission("staffs", "read"),
      this.organizationController.getTeams,
    );
    this.router.get(
      "/teams/:teamId",
      requireAuth,
      requirePermission("staffs", "read"),
      this.organizationController.getTeam,
    );
    this.router.post(
      "/teams",
      requireAuth,
      requirePermission("staffs", "create"),
      this.organizationController.createTeam,
    );
    this.router.get(
      "/staff",
      requireAuth,
      requirePermission("staffs", "read"),
      this.organizationController.getAll,
    );
    this.router.get(
      "/staff/:staffId",
      requireAuth,
      requirePermission("staffs", "read"),
      this.organizationController.getStaff,
    );
    this.router.post(
      "/invite",
      requireAuth,
      requirePermission("staffs", "create"),
      this.organizationController.invite,
    );
    this.router.post(
      "/accept-invite",
      requireAuth,
      this.organizationController.acceptInvite,
    );
    this.router.get(
      "/my-pending-invitation",
      requireAuth,
      this.organizationController.getMyPendingInvitation,
    );
    this.router.get(
      "/needs-setup",
      requireAuth,
      this.organizationController.needsSetup,
    );
    this.router.get(
      "/invitations",
      requireAuth,
      requirePermission("staffs", "create"),
      this.organizationController.getInvitations,
    );
    this.router.post(
      "/cancel-invitation",
      requireAuth,
      this.organizationController.cancelInvitation,
    );
    this.router.delete(
      "/staff/:staffId",
      requireAuth,
      requirePermission("staffs", "delete"),
      this.organizationController.deleteStaff,
    );
    this.router.patch(
      "/staff/:staffId",
      requireAuth,
      requirePermission("staffs", "update"),
      this.organizationController.updateStaff,
    );
    this.router.patch(
      "/staff/:staffId/role",
      requireAuth,
      requirePermission("staffs", "update"),
      this.organizationController.updateStaffRole,
    );
    this.router.post(
      "/resend-invitation",
      requireAuth,
      this.organizationController.resendInvitation,
    );
    this.router.patch(
      "/teams/:teamId",
      requireAuth,
      requirePermission("staffs", "update"),
      this.organizationController.updateTeam,
    );
    this.router.post(
      "/teams/:teamId/members",
      requireAuth,
      requirePermission("staffs", "update"),
      this.organizationController.addTeamMembers,
    );
    this.router.delete(
      "/teams/:teamId",
      requireAuth,
      requirePermission("staffs", "delete"),
      this.organizationController.deleteTeam,
    );
    this.router.delete(
      "/teams/:teamId/members/:memberId",
      requireAuth,
      requirePermission("staffs", "update"),
      this.organizationController.removeTeamMember,
    );
    this.router.post(
      "/set-password",
      requireAuth,
      this.organizationController.setPassword,
    );
  }
}
