/**
 * @openapi
 * tags:
 *   - name: Organization
 *     description: Organization invitations & membership
 */
import { Router } from "express";
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
    this.router.use(this.path, this.router);

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
    this.router.post("/invite", this.organizationController.invite);

    /**
     * @openapi
     * /organization/accept-invitation:
     *   post:
     *     tags: [Organization]
     *     summary: Accept an organization invitation
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: "#/components/schemas/AcceptInvitationRequest"
     *     responses:
     *       200:
     *         description: Invitation accepted
     *         content:
     *           application/json:
     *             schema:
     *               $ref: "#/components/schemas/MessageResponse"
     */
    this.router.post(
      "/accept-invitation",
      this.organizationController.acceptInvite,
    );

    /**
     * @openapi
     * /organization/invitations:
     *   get:
     *     tags: [Organization]
     *     summary: List pending invitations for the current user
     *     responses:
     *       200:
     *         description: List of invitations
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: "#/components/schemas/Invitation"
     */
    this.router.get("/invitations", this.organizationController.getInvitations);
  }
}
