import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { openAPI, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { db } from "./db/client";
import {
  account,
  invitation,
  member,
  organization as organizationSchema,
  session,
  user,
  verification,
} from "./db/schema/auth-schema";

// Email configuration constants
const EMAIL_CONFIG = {
  SERVICE: "gmail",
  VERIFICATION_EXPIRE_TIME: "30 minutes",
  VERIFICATION_SUBJECT: "Verify Your Email Address",
  PASSWORD_RESET_EXPIRE_TIME: "30 minutes",
  PASSWORD_RESET_SUBJECT: "Reset Your Password",
  FROM_ADDRESS: "noreply@oravanti.com",
};

// Initialize email transporter
const transporter = nodemailer.createTransport({
  service: EMAIL_CONFIG.SERVICE,
  auth: {
    user: process.env.SMTP_EMAIL_ADDRESS,
    pass: process.env.SMTP_PASSWORD,
  },
});

/**
 * Generate email verification HTML template
 */
function generateVerificationEmailTemplate(url: string): string {
  return `
    <div style="font-family: Arial, sans-serif; color: #333;">
      <h2>Email Verification</h2>
      <p>Thank you for signing up! Please verify your email address by clicking the link below.</p>
      <a href="${url}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;">
        Verify Email
      </a>
      <p style="color: #666; font-size: 14px;">
        <strong>Link expires in ${EMAIL_CONFIG.VERIFICATION_EXPIRE_TIME}</strong>
      </p>
      <p style="color: #999; font-size: 12px;">
        If you didn't sign up for this account, you can ignore this email.
      </p>
    </div>
  `;
}

/**
 * Generate password reset HTML template
 */
function generatePasswordResetEmailTemplate(url: string): string {
  return `
    <div style="font-family: Arial, sans-serif; color: #333;">
      <h2>Password Reset</h2>
      <p>We received a request to reset your password. Click the link below to continue.</p>
      <a href="${url}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;">
        Reset Password
      </a>
      <p style="color: #666; font-size: 14px;">
        <strong>Link expires in ${EMAIL_CONFIG.PASSWORD_RESET_EXPIRE_TIME}</strong>
      </p>
      <p style="color: #999; font-size: 12px;">
        If you did not request a password reset, you can ignore this email.
      </p>
    </div>
  `;
}

/**
 * Send verification email
 */
async function sendVerificationEmail(
  userEmail: string,
  verificationUrl: string,
): Promise<void> {
  const mailOptions = {
    from: EMAIL_CONFIG.FROM_ADDRESS,
    to: userEmail,
    subject: EMAIL_CONFIG.VERIFICATION_SUBJECT,
    html: generateVerificationEmailTemplate(verificationUrl),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Verification email sent to ${userEmail}`);
  } catch (error) {
    console.error(`Failed to send verification email to ${userEmail}:`, error);
    throw error;
  }
}

/**
 * Send password reset email
 */
async function sendPasswordResetEmail(
  userEmail: string,
  resetUrl: string,
): Promise<void> {
  const mailOptions = {
    from: EMAIL_CONFIG.FROM_ADDRESS,
    to: userEmail,
    subject: EMAIL_CONFIG.PASSWORD_RESET_SUBJECT,
    html: generatePasswordResetEmailTemplate(resetUrl),
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Password reset email sent to ${userEmail}`);
  } catch (error) {
    console.error(
      `Failed to send password reset email to ${userEmail}:`,
      error,
    );
    throw error;
  }
}

const isProduction = process.env.NODE_ENV === "production";

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
  trustedOrigins: (process.env.CORS_ORIGIN as string)
    .split(",")
    .map((origin) => origin.trim()),
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
    },
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }, request) => {
      await sendPasswordResetEmail(user.email, url);
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url, token }) => {
      await sendVerificationEmail(user.email, url);
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
    openAPI(),
  ],
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const organization = await getActiveOrganization(session.userId);
          return {
            data: {
              ...session,
              activeOrganizationId: organization?.id,
            },
          };
        },
      },
    },
  },
  telemetry: { enabled: false },
});
