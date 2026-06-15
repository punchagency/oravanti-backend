import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  emailOTP,
  openAPI,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { env } from "../config/env";
import { db } from "../db/client";
import {
  account,
  invitation,
  member,
  organization as organizationSchema,
  session,
  twoFactor as twoFactorSchema,
  user,
  verification,
} from "../db/schema/auth-schema";
import { emailService } from "../utils/email/email.service";
import { ac, admin, attorney, owner, paralegal } from "./permissions";
import { cryptoKeyPlugin } from "./plugins/cryptoKeyPlugin";
import { databaseHooks } from "./database-hooks";

const { isProduction } = env;

export { getActiveOrganization } from "./helpers";

export const auth = betterAuth({
  appName: "Oravanti",
  baseURL: env.BETTER_AUTH_URL,
  account: {
    skipStateCookieCheck: true,
    accountLinking: {
      allowDifferentEmails: true,
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
      userType: { type: "string", required: false, input: true },
    },
  },
  session: {
    additionalFields: {
      location: { type: "string", required: false, input: true },
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
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
  },
  plugins: [
    organization({
      async sendInvitationEmail(data) {
        const inviteLink = `http://localhost:5137/accept-invitation?id=${data.id}`;

        await emailService.sendOrganizationInvitationEmail({
          email: data.email,
          invitedByUsername: data.inviter.user.name,
          invitedByEmail: data.inviter.user.email,
          teamName: data.organization.name,
          inviteLink,
        });
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
