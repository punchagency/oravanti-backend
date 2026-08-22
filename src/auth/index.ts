import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { symmetricDecrypt } from "better-auth/crypto";
import {
  customSession,
  emailOTP,
  openAPI,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { and, eq, inArray } from "drizzle-orm";
import { env } from "../config/env";
import { EMAIL_VERIFICATION_EXEMPT_ACCOUNT_TYPES } from "../config/constants";
import { systemDb } from "../db/client";
import { clients as clientsSchema, staff } from "../db/schema";
import {
  account,
  invitation,
  member,
  organization as organizationSchema,
  organizationRole,
  session,
  team,
  teamMember,
  twoFactor as twoFactorSchema,
  user,
  verification,
} from "../db/schema/auth-schema";
import { consultationSettings } from "../db/schema/consultation-settings";
import { roleGroup, roleGroupMember } from "../db/schema/role-groups";
import { emailService } from "../utils/email/email.service";
import { databaseHooks } from "./database-hooks";
import {
  ac,
  admin,
  client,
  clientPermissions,
  contractorPermissions,
  owner,
  resolveStaticGrants,
} from "./permissions";
import { cryptoKeyPlugin } from "./plugins/cryptoKeyPlugin";

const { isProduction } = env;

export { getActiveOrganization } from "./helpers";

export const auth = betterAuth({
  appName: "Oravanti",
  baseURL: env.BETTER_AUTH_URL,
  account: {
    skipStateCookieCheck: true,
    accountLinking: {
      allowDifferentEmails: true,
      // Microsoft must be a trustedProvider because Entra ID never returns
      // emailVerified:true. Without it, Better Auth rejects the link at
      // callback.mjs:104 ("unable_to_link_account"). Google works without
      // this because it does return emailVerified:true.
      trustedProviders: ["microsoft"],
    },
  },
  trustedOrigins: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
  advanced: {
    cookiePrefix: "oravanti",
    defaultCookieAttributes: {
      sameSite: isProduction ? "none" : "lax",
      secure: isProduction,
    },
  },
  database: drizzleAdapter(systemDb, {
    provider: "pg",
    schema: {
      user,
      session,
      account,
      verification,
      member,
      organization: organizationSchema,
      invitation,
      twoFactor: twoFactorSchema,
      team,
      teamMember,
      organizationRole,
    },
  }),
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url }) => {
      await emailService.sendPasswordResetEmail({ email: user.email, url });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      if (EMAIL_VERIFICATION_EXEMPT_ACCOUNT_TYPES.has((user as any).accountType)) return;
      await emailService.sendVerificationEmail({ email: user.email, url });
    },
    sendOnSignUp: true,
    sendOnSignIn: true,
    expiresIn: 1800,
    autoSignInAfterVerification: true,
  },
  user: {
    additionalFields: {
      accountType: { type: "string", required: false, input: true },
      onboardingState: { type: "string", required: false, input: true },
      tosAccepted: { type: "boolean", required: false, input: true },
      tosAcceptedAt: { type: "date", required: false, input: true },
      encryptedDEK: { type: "string", required: false },
      dekIv: { type: "string", required: false },
      dekTag: { type: "string", required: false },
    },
  },
  session: {
    additionalFields: {
      location: { type: "string", required: false, input: true },
    },
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      scope: [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.readonly",
        "openid",
        "email",
        "profile",
      ],
      prompt: "consent",
      accessType: "offline",
    },
    microsoft: {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      scope: [
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/Mail.Read",
        "https://graph.microsoft.com/User.Read",
        "openid",
        "email",
        "profile",
        "offline_access",
      ],
      prompt: "consent",
    },
  },
  plugins: [
    organization({
      // cancelPendingInvitationsOnReInvite: true,
      membershipLimit: 1000,
      teams: {
        enabled: true,
        defaultTeam: { enabled: false },
      },
      async sendInvitationEmail(data) {
        const loginUrl = `${env.FRONTEND_APP_URL || "http://localhost:5173"}/login?email=${encodeURIComponent(data.email)}`;

        const [staffRecord] = await systemDb
          .select({ tempPassword: staff.tempPassword })
          .from(staff)
          .where(
            and(
              eq(staff.email, data.email),
              eq(staff.organizationId, data.organization.id),
            ),
          )
          .limit(1);

        if (staffRecord?.tempPassword) {
          const plaintextPassword = await symmetricDecrypt({
            key: env.BETTER_AUTH_SECRET,
            data: staffRecord.tempPassword,
          });

          await emailService.sendInvitationWithCredentials({
            email: data.email,
            tempPassword: plaintextPassword,
            inviteLink: `${loginUrl}&password=${encodeURIComponent(plaintextPassword)}`,
            invitedByUsername: data.inviter.user.name,
            invitedByEmail: data.inviter.user.email,
            orgName: data.organization.name,
          });
          return;
        }

        await emailService.sendOrganizationInvitationEmail({
          email: data.email,
          invitedByUsername: data.inviter.user.name,
          invitedByEmail: data.inviter.user.email,
          orgName: data.organization.name,
          inviteLink: loginUrl,
        });
      },
      organizationHooks: {
        // `member.role` (via better-auth, now possibly comma-separated for a
        // multi-role member) is the sole source of truth for *authorization*.
        // `staff.role` remains only as a best-effort, single-value "primary
        // role" projection — the first role in the list — for the many
        // read-only call sites (billing rate lookup, case-review assignee
        // matching, task/lead routing) that display or group by "a" role and
        // were never rewritten to read `member.role` directly. Both hooks run
        // on `systemDb` (bypasses RLS), so the organization predicate is the
        // only thing scoping the write — without it a user who belongs to
        // two firms has their projection at BOTH firms overwritten when
        // their membership changes at one of them.
        afterAcceptInvitation: async ({ member, user }) => {
          await systemDb
            .update(staff)
            .set({
              role: member.role.split(",")[0] as any,
              status: "active",
            })
            .where(
              and(
                eq(staff.userId, user.id),
                eq(staff.organizationId, member.organizationId),
              ),
            );
        },
        afterUpdateMemberRole: async ({ member }) => {
          await systemDb
            .update(staff)
            .set({ role: member.role.split(",")[0] as any })
            .where(
              and(
                eq(staff.userId, member.userId),
                eq(staff.organizationId, member.organizationId),
              ),
            );
        },
      },
      ac,
      // Only owner/admin/client are still statically defined here — see the
      // comment on `DEFAULT_ROLE_NAMES` in `permissions.ts` for why the four
      // default staff roles (attorney, paralegal, legal_assistant,
      // receptionist) are deliberately NOT in this map: a name in this map
      // can never get a real, editable `organizationRole` DB row of its
      // own, which is what "edit this role" and "reset to default" need.
      roles: {
        owner,
        admin,
        client,
      },
      dynamicAccessControl: {
        enabled: true,
        // No firm-tier/subscription-plan concept exists yet to hang a
        // variable ceiling off — flat and generous until one does.
        maximumRolesPerOrganization: 30,
      },
      schema: {
        organization: {
          additionalFields: {
            emailAddress: { type: "string", input: true, required: false },
            phoneNumber: { type: "string", input: true, required: false },
            address: { type: "string", input: true, required: false },
            city: { type: "string", input: true, required: false },
            state: { type: "string", input: true, required: false },
            zipCode: { type: "string", input: true, required: false },
            website: { type: "string", input: true, required: false },
            taxId: { type: "string", input: true, required: false },
          },
        },
        team: {
          additionalFields: {
            leadId: { type: "string", required: false },
            description: { type: "string", required: false },
            maxCaseload: { type: "number", required: false },
            workloadPercentage: { type: "number", required: false },
            status: { type: "string", required: false },
            activeCases: { type: "number", required: false },
          },
        },
      },
    }),
    twoFactor(),
    openAPI(),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        await emailService.sendVerificationOTP({ email, otp, type });
      },
    }),
    cryptoKeyPlugin(),
    // Surface the active organization member role(s) and the caller's
    // resolved permission grants on the session, so the frontend can gate UI
    // without an extra request. The backend permission remains the real gate
    // — this is a display/UX convenience, not itself an enforcement point.
    customSession(async ({ user, session }) => {
      const activeOrganizationId = (
        session as { activeOrganizationId?: string }
      ).activeOrganizationId;

      // Comma-separated when the member holds more than one role — kept as
      // the raw string on the session (unchanged shape), split only where
      // grants are resolved.
      let memberRole: string | null = null;
      let firmTimezone = "UTC";
      let grants: string[] = [];
      if (activeOrganizationId) {
        const [membership] = await systemDb
          .select({ id: member.id, role: member.role })
          .from(member)
          .where(
            and(
              eq(member.userId, user.id),
              eq(member.organizationId, activeOrganizationId),
            ),
          )
          .limit(1);
        memberRole = membership?.role ?? null;

        // Direct roles from member.role
        const directRoles = (membership?.role ?? "")
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);

        // ── Group-inherited roles ────────────────────────────────────────
        let groupRoleNames: string[] = [];
        if (membership) {
          const memberships = await systemDb
            .select({ groupId: roleGroupMember.groupId })
            .from(roleGroupMember)
            .where(eq(roleGroupMember.memberId, membership.id));

          if (memberships.length > 0) {
            const groupIds = memberships.map((m) => m.groupId);
            const groups = await systemDb
              .select({ roles: roleGroup.roles })
              .from(roleGroup)
              .where(inArray(roleGroup.id, groupIds));

            const groupRoles = new Set<string>();
            for (const g of groups) {
              if (g.roles) {
                for (const r of g.roles.split(",").map((r) => r.trim()).filter(Boolean)) {
                  groupRoles.add(r);
                }
              }
            }
            groupRoleNames = Array.from(groupRoles);
          }
        }

        // Union of direct + group roles (additive — groups only widen access)
        const roleNames = Array.from(new Set([...directRoles, ...groupRoleNames]));

        // Expose the full effective role set on the session so the frontend
        // can display it (memberRole) and the panel shows group-inherited roles.
        if (groupRoleNames.length > 0) {
          memberRole = roleNames.join(",");
        }

        grants = resolveStaticGrants(roleNames);

        // Layer in every DB-backed role — the four seeded defaults
        // (attorney, paralegal, legal_assistant, receptionist) plus any
        // firm-created custom role. Queried directly — no
        // `auth.api.getOrgRole` here, since this callback has no request
        // headers to authenticate that call with, and it already has the
        // org/role context it needs.
        const dbRoleNames = roleNames.filter((name) => name !== "owner" && name !== "admin" && name !== "client");
        if (dbRoleNames.length > 0) {
          const dbRoles = await systemDb
            .select({ role: organizationRole.role, permission: organizationRole.permission })
            .from(organizationRole)
            .where(
              and(
                eq(organizationRole.organizationId, activeOrganizationId),
                inArray(organizationRole.role, dbRoleNames),
              ),
            );
          const grantSet = new Set(grants);
          for (const row of dbRoles) {
            try {
              const permission = JSON.parse(row.permission) as Record<string, string[]>;
              for (const [resource, actions] of Object.entries(permission)) {
                for (const action of actions) grantSet.add(`${resource}:${action}`);
              }
            } catch {
              // Malformed permission JSON — skip rather than fail the whole session.
            }
          }
          grants = Array.from(grantSet);
        }

        // Firm timezone drives business-logic and coordination (firm) display.
        const [settings] = await systemDb
          .select({ timezone: consultationSettings.timezone })
          .from(consultationSettings)
          .where(eq(consultationSettings.organizationId, activeOrganizationId))
          .limit(1);
        firmTimezone = settings?.timezone ?? "UTC";
      } else if ((user as any).accountType === "client") {
        grants = Object.entries(clientPermissions).flatMap(([resource, actions]) =>
          actions.map((action) => `${resource}:${action}`),
        );
      } else if ((user as any).accountType === "contractor") {
        grants = Object.entries(contractorPermissions).flatMap(([resource, actions]) =>
          actions.map((action) => `${resource}:${action}`),
        );
      }

      // User's own timezone preference (null → client falls back to browser).
      // Lives on the staff record (staff is the source of truth for profile data).
      const [staffTimezone] = await systemDb
        .select({ timezone: staff.timezone })
        .from(staff)
        .where(eq(staff.userId, user.id))
        .limit(1);

      // Portal access status for client/staff portal gating.
      let portalStatus: string | null = null;
      if ((user as any).accountType === "client") {
        const [clientRecord] = await systemDb
          .select({ portalStatus: clientsSchema.portalStatus })
          .from(clientsSchema)
          .where(eq(clientsSchema.userId, user.id))
          .limit(1);
        portalStatus = clientRecord?.portalStatus ?? null;
      } else if (
        (user as any).accountType === "staff" ||
        (user as any).accountType === "firm_admin"
      ) {
        const [staffRecord] = await systemDb
          .select({ portalStatus: staff.portalStatus })
          .from(staff)
          .where(eq(staff.userId, user.id))
          .limit(1);
        portalStatus = staffRecord?.portalStatus ?? null;
      }

      return {
        user: { ...user, timezone: staffTimezone?.timezone ?? null },
        session,
        memberRole,
        firmTimezone,
        portalStatus,
        grants,
      };
    }),
  ],
  databaseHooks,
  telemetry: { enabled: false },
  onAPIError: {
    throw: true,
  },
});
