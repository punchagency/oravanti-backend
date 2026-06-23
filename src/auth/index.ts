import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { symmetricDecrypt } from "better-auth/crypto";
import {
  emailOTP,
  openAPI,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { and, eq } from "drizzle-orm";
import { env } from "../config/env";
import { db } from "../db/client";
import { staff } from "../db/schema";
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
import { emailService } from "../utils/email/email.service";
import { databaseHooks } from "./database-hooks";
import { ac, admin, attorney, owner, paralegal } from "./permissions";
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
    },
  },
  database: drizzleAdapter(db, {
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
      console.log({ user });

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
      teams: {
        enabled: true,
      },
      async sendInvitationEmail(data) {
        const inviteLink = `http://localhost:5137/accept-invitation?id=${data.id}`;

        const [staffRecord] = await db
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
            inviteLink,
            invitedByUsername: data.inviter.user.name,
            invitedByEmail: data.inviter.user.email,
            teamName: data.organization.name,
          });
          return;
        }

        await emailService.sendOrganizationInvitationEmail({
          email: data.email,
          invitedByUsername: data.inviter.user.name,
          invitedByEmail: data.inviter.user.email,
          teamName: data.organization.name,
          inviteLink,
        });
      },
      organizationHooks: {
        afterAcceptInvitation: async ({ member, user }) => {
          await db
            .update(staff)
            .set({ role: member.role as any, status: "active" })
            .where(eq(staff.userId, user.id));
        },
        afterUpdateMemberRole: async ({ member }) => {
          await db
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
  ],
  databaseHooks,
  telemetry: { enabled: false },
  onAPIError: {
    throw: true,
  },
});
