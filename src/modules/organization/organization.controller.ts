import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../../auth";
import { db } from "../../db/client";
import { staff } from "../../db/schema";
import asyncWrap from "../../utils/asyncWrapper";
import { OrganizationService } from "./organization.service";

export class OrganizationController {
  private organizationService: OrganizationService;

  constructor(organizationService: OrganizationService) {
    this.organizationService = organizationService;
  }

  invite = asyncWrap(async (req, res) => {
    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      role,
      maxCaseLoad,
      startDate,
    } = req.body;

    // Verify user session
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) return res.status(401).json({ error: "Access Denied" });

    const activeOrgId = session.session.activeOrganizationId;

    try {
      const formattedEmail = email.toLowerCase().trim();

      // 1. Stage profile tracking metrics via email unique constraint
      await db.insert(staff).values({
        organizationId: activeOrgId!,
        userId: session.session.userId,
        firstName,
        lastName,
        phone: phoneNumber,
        jobTitle: role
      });

      // 2. Correct Better Auth core API invocation
      // The plugin exposes 'inviteMember' corresponding to the "/organization/invite-member" endpoint
      const invitation = await auth.api.createInvitation({
        body: {
          organizationId: activeOrgId!,
          email: formattedEmail,
          role: role, // e.g., "admin", "member"
          resend: true,
        },
        headers: fromNodeHeaders(req.headers), // Pass headers so Better Auth knows WHO is inviting
      });

      // NOTE: Better Auth natively handles the execution of your `sendInvitationEmail` config hook here.
      // If you need a fallback manual tracking link, you can grab it from the return payload:
      if (invitation && "id" in invitation) {
        const backupInviteLink = `http://localhost:3000/invite/entry?id=${invitation.id}`;

        console.log(
          `[STAFF INVITE INITIALIZED] Backup Link: ${backupInviteLink}`,
        );
      }

      return res
        .status(201)
        .json({ message: "Staff invite data successfully initialized." });
    } catch (error) {
      console.error("Invitation dispatch error:", error);
      return res.status(500).json({
        error: "Internal processing crash generating invite token logs.",
      });
    }
  });

  acceptInvite = asyncWrap(async (req, res) => {
    const { invitationId } = req.body;
    const data = await auth.api.acceptInvitation({
      body: {
        invitationId, // required
      },
      // This endpoint requires session cookies.
      headers: fromNodeHeaders(req.headers),
    });

    res.status(200).json({ message: "Invitation accepted", data });
  });

  getInvitations = asyncWrap(async (req, res) => {
    // Verify user session
    const invitations = await auth.api.listInvitations({
      headers: fromNodeHeaders(req.headers),
    });

    res.status(200).json({ message: "Invitations listed", data: invitations });
  });
}
