import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import {
  emailOTP,
  openAPI,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { env } from "../config/env";
import { db } from "../db/client";
import { admins } from "../db/schema/admins";
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
import { staff } from "../db/schema/staff";
import { emailService } from "../utils/email/email.service";
import { ac, admin, attorney, owner } from "./permissions";

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

const splitName = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "Admin",
    lastName: parts.slice(1).join(" ") || "User",
  };
};

const createDefaultAdminStaff = async ({
  organizationId,
  userId,
  role,
  name,
  email,
  firstName,
  lastName,
  phoneNumber,
  image,
}: {
  organizationId: string;
  userId: string;
  role: string;
  name: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phoneNumber?: string | null;
  image?: string | null;
}) => {
  const memberRoles = role.split(",").map((currentRole) => currentRole.trim());
  if (
    !memberRoles.some(
      (currentRole) => currentRole === "owner" || currentRole === "admin",
    )
  ) {
    return;
  }

  const fallbackName = splitName(name);
  const adminFirstName = firstName || fallbackName.firstName;
  const adminLastName = lastName || fallbackName.lastName;
  const startDate = new Date().toISOString().split("T")[0];

  await db
    .insert(admins)
    .values({
      organizationId,
      userId,
      firstName: adminFirstName,
      lastName: adminLastName,
      email,
      avatarUrl: image,
    })
    .onConflictDoNothing();

  await db
    .insert(staff)
    .values({
      organizationId,
      userId,
      firstName: adminFirstName,
      lastName: adminLastName,
      email,
      phone: phoneNumber || "",
      role: "admin",
      status: "active",
      startDate,
    })
    .onConflictDoNothing();
};

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

  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      // Target the email sign-up endpoint specifically
      if (ctx.path === "/sign-up/email") {
        const newSession = ctx.context.newSession;

        // Ensure a session and user were actually successfully created
        if (newSession && newSession.user) {
          const { user } = newSession;

          try {
            await db
              .update(staff)
              .set({ userId: user.id })
              .where(eq(staff.email, user.email.toLowerCase().trim()));

            console.log(
              `[STITCH SUCCESS] Bound user ID ${user.id} to profile matching email: ${user.email}`,
            );
          } catch (error) {
            console.error(
              "[STITCH ERROR] Profiling synchronization crash:",
              error,
            );
          }
        }
      }
    }),
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
      },
      organizationHooks: {
        afterAddMember: async ({ organization, user, member }) => {
          await createDefaultAdminStaff({
            organizationId: organization.id,
            userId: user.id,
            role: member.role,
            name: user.name,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            phoneNumber: user.phoneNumber,
            image: user.image,
          });
        },
      },
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
  onAPIError: {
    throw: true, // Forces Better Auth to throw traditional exceptions even with asResponse: true
  },
});
