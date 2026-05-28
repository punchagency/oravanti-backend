import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  emailOTP,
  openAPI,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { env } from "./config/env";
import { db } from "./db/client";
import {
  account,
  invitation,
  member,
  organization as organizationSchema,
  session,
  twoFactor as twoFactorSchema,
  user,
  verification,
} from "./db/schema/auth-schema";
import { emailService } from "./utils/email/email.service";

const { isProduction } = env;

export async function getActiveOrganization(userId: string) {
  const [memberUser] = await db
    .select()
    .from(member)
    .where(eq(member.userId, userId));

  if (!memberUser) {
    return null;
  }

  const [activeOrganization] = await db
    .select()
    .from(organizationSchema)
    .where(eq(organizationSchema.id, memberUser.organizationId));

  return activeOrganization;
}

export const auth = betterAuth({
  appName: "Oravanti",
  trustedOrigins: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
  advanced: {
    cookiePrefix: "oravanti",
    defaultCookieAttributes: {
      sameSite: isProduction ? "none" : "lax", // 'none' for cross-site in prod, 'lax' for dev
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
    // requireEmailVerification: true,
    sendResetPassword: async ({ user, url }, request) => {
      await emailService.sendPasswordResetEmail({ email: user.email, url });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url, token }) => {
      await emailService.sendVerificationEmail({ email: user.email, url });
    },
    sendOnSignUp: true,
    sendOnSignIn: true,
    expiresIn: 1800, // 30 minutes in seconds
    autoSignInAfterVerification: true,
  },
  user: {
    additionalFields: {
      firstName: { type: "string", required: false, input: true },
      lastName: { type: "string", required: false, input: true },
      phoneNumber: { type: "string", required: false, input: true },
      jobTitle: { type: "string", required: false, input: true },
      barNumber: { type: "string", required: false, input: true },
    },
  },
  session: {
    additionalFields: {
      location: { type: "string", required: false, input: true },
    },
  },
  plugins: [
    organization({
      schema: {
        organization: {
          additionalFields: {
            // Add a new field to the organization table
            emailAddress: {
              type: "string",
              input: true,
              required: false,
            },
            phoneNumber: {
              type: "string",
              input: true,
              required: false,
            },
            address: {
              type: "string",
              input: true,
              required: false,
            },
            city: {
              type: "string",
              input: true,
              required: false,
            },
            state: {
              type: "string",
              input: true,
              required: false,
            },
            zipCode: {
              type: "string",
              input: true,
              required: false,
            },
            website: {
              type: "string",
              input: true,
              required: false,
            },
            taxId: {
              type: "string",
              input: true,
              required: false,
            },
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
  ],
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const organization = await getActiveOrganization(session.userId);

          const ipAddress = session.ipAddress;
          let locationStr = "Unknown Location";

          // Bypass localhost/internal IPs during development
          if (ipAddress && ipAddress !== "::1" && ipAddress !== "127.0.0.1") {
            try {
              const response = await fetch(
                `http://ip-api.com/json/${ipAddress}`,
              );
              const data = await response.json();

              console.log(data);

              if (!data.error && data.city && data.country) {
                locationStr = `${data.city}, ${data.country}`;
              }
            } catch (error) {
              console.error("Failed to fetch IP location:", error);
            }
          }

          // Append the location data to the session object being saved
          return {
            data: {
              ...session,
              activeOrganizationId: organization?.id,
              location: locationStr,
            },
          };
        },
      },
    },
  },
  telemetry: { enabled: false },
});
