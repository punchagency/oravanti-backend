/**
 * @openapi
 * tags:
 *   - name: Organization
 *     description: Organization management (teams, staffs, invitations)
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requirePermission } from "../../middleware/permission.middleware";
import { resolveActorContext } from "../../middleware/resolve-actor-context";
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
    this.router.use(requireAuth);
    this.router.use(resolveActorContext);

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
      "/staffs",
      requireAuth,
      requirePermission("staffs", "read"),
      this.organizationController.getStaffs,
    );
    this.router.get(
      "/staffs/:staffId",
      requireAuth,
      requirePermission("staffs", "read"),
      this.organizationController.getStaffMember,
    );
    this.router.post(
      "/invite",
      requireAuth,
      requirePermission("staffs", "create"),
      this.organizationController.invite,
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
      requirePermission("invitations", "delete"),
      this.organizationController.cancelInvitation,
    );
    this.router.delete(
      "/staffs/:staffId",
      requireAuth,
      requirePermission("staffs", "delete"),
      this.organizationController.removeStaffMember,
    );
    this.router.patch(
      "/staffs/:staffId",
      requireAuth,
      requirePermission("staffs", "update"),
      this.organizationController.updateStaffMember,
    );
    this.router.patch(
      "/staffs/:staffId/role",
      requireAuth,
      requirePermission("staffs", "update"),
      this.organizationController.updateStaffMemberRole,
    );
    this.router.patch(
      "/staffs/:staffId/portal-status",
      requireAuth,
      // Its own `portal:update` grant — not `staffs:update` — so editing a
      // staff profile and granting/revoking portal sign-in are separately
      // controllable. Default roles: owner/admin only.
      requirePermission("portal", "update"),
      this.organizationController.updateStaffPortalStatus,
    );
    this.router.post(
      "/resend-invitation",
      requireAuth,
      requirePermission("invitations", "create"),
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
    this.router.get("/needs-setup", this.organizationController.needsSetup);
    this.router.get(
      "/my-pending-invitation",
      this.organizationController.getMyPendingInvitation,
    );
    this.router.post(
      "/accept-invite",
      this.organizationController.acceptInvite,
    );
    this.router.post("/set-password", this.organizationController.setPassword);
  }
}
