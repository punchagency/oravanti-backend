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
import { and, eq } from "drizzle-orm";
import { env } from "../config/env";
import { EMAIL_VERIFICATION_EXEMPT_ACCOUNT_TYPES } from "../config/constants";
import { systemDb } from "../db/client";
import { clients as clientsSchema, staff } from "../db/schema";
import {
  account,
  invitation,
  member,
  organization as organizationSchema,
  session,
  team,
  teamMember,
  twoFactor as twoFactorSchema,
  user,
  verification,
} from "../db/schema/auth-schema";
import { consultationSettings } from "../db/schema/consultation-settings";
import { emailService } from "../utils/email/email.service";
import { databaseHooks } from "./database-hooks";
import { ac, admin, attorney, client, owner, paralegal } from "./permissions";
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
        afterAcceptInvitation: async ({ member, user }) => {
          await systemDb
            .update(staff)
            .set({ role: member.role as any, status: "active" })
            .where(eq(staff.userId, user.id));
        },
        afterUpdateMemberRole: async ({ member }) => {
          await systemDb
            .update(staff)
            .set({ role: member.role as any })
            .where(eq(staff.userId, member.userId));
        },
      },
      ac,
      roles: {
        owner,
        admin,
        attorney,
        paralegal,
        client
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
    // Surface the active organization member role (owner/admin/attorney/
    // paralegal) on the session so the frontend can gate conflict review
    // without an extra request. The backend permission remains the real gate.
    customSession(async ({ user, session }) => {
      const activeOrganizationId = (
        session as { activeOrganizationId?: string }
      ).activeOrganizationId;

      let memberRole: string | null = null;
      let firmTimezone = "UTC";
      if (activeOrganizationId) {
        const [membership] = await systemDb
          .select({ role: member.role })
          .from(member)
          .where(
            and(
              eq(member.userId, user.id),
              eq(member.organizationId, activeOrganizationId),
            ),
          )
          .limit(1);
        memberRole = membership?.role ?? null;

        // Firm timezone drives business-logic and coordination (firm) display.
        const [settings] = await systemDb
          .select({ timezone: consultationSettings.timezone })
          .from(consultationSettings)
          .where(eq(consultationSettings.organizationId, activeOrganizationId))
          .limit(1);
        firmTimezone = settings?.timezone ?? "UTC";
      }

      if (memberRole === "") {
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
      } else if ((user as any).accountType === "staff") {
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
      };
    }),
  ],
  databaseHooks,
  telemetry: { enabled: false },
  onAPIError: {
    throw: true,
  },
});
