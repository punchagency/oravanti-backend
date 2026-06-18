import nodemailer from "nodemailer";
import { env } from "../../config/env";

const EMAIL_CONFIG = {
  service: "gmail",
  fromAddress: "noreply@oravanti.com",
  verificationSubject: "Verify Your Email Address",
  passwordResetSubject: "Reset Your Password",
  verificationExpireTime: "30 minutes",
  passwordResetExpireTime: "30 minutes",
  otpExpireTime: "5 minutes",
} as const;

type SendEmailOptions = {
  to: string;
  subject: string;
  html: string;
};

type SendAuthLinkEmailOptions = {
  email: string;
  url: string;
};

type VerificationOTPType =
  | "sign-in"
  | "email-verification"
  | "forget-password"
  | "change-email";

type SendVerificationOTPOptions = {
  email: string;
  otp: string;
  type: VerificationOTPType;
};

const authLinkButtonStyle =
  "display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;";

const authLinkShellStyle = "font-family: Arial, sans-serif; color: #333;";

const generateVerificationEmailTemplate = (url: string): string => `
  <div style="${authLinkShellStyle}">
    <h2>Email Verification</h2>
    <p>Thank you for signing up! Please verify your email address by clicking the link below.</p>
    <a href="${url}" style="${authLinkButtonStyle}">
      Verify Email
    </a>
    <p style="color: #666; font-size: 14px;">
      <strong>Link expires in ${EMAIL_CONFIG.verificationExpireTime}</strong>
    </p>
    <p style="color: #999; font-size: 12px;">
      If you didn't sign up for this account, you can ignore this email.
    </p>
  </div>
`;

const generatePasswordResetEmailTemplate = (url: string): string => `
  <div style="${authLinkShellStyle}">
    <h2>Password Reset</h2>
    <p>We received a request to reset your password. Click the link below to continue.</p>
    <a href="${url}" style="${authLinkButtonStyle}">
      Reset Password
    </a>
    <p style="color: #666; font-size: 14px;">
      <strong>Link expires in ${EMAIL_CONFIG.passwordResetExpireTime}</strong>
    </p>
    <p style="color: #999; font-size: 12px;">
      If you did not request a password reset, you can ignore this email.
    </p>
  </div>
`;

const generateEmailVerificationOTPTemplate = (otp: string): string => `
  <p>Thank you for signing up!</p>
  <p>Please use the OTP below to verify your email address:</p>
  <p>Your OTP is: <strong>${otp}</strong></p>
  <p>This OTP will expire in ${EMAIL_CONFIG.otpExpireTime}.</p>
`;

const generatePasswordResetOTPTemplate = (otp: string): string => `
  <p>We received a request to reset your password. Please use the OTP below to verify your new password:</p>
  <p>Your OTP for password reset is: <strong>${otp}</strong></p>
  <p>This OTP will expire in ${EMAIL_CONFIG.otpExpireTime}.</p>
`;

const generateChangeEmailVerificationTemplate = (otp: string): string => `
  <p>We received a request to change your email address. Please use the OTP below to verify your new email address:</p>
  <p>Your OTP for changing email is: <strong>${otp}</strong></p>
  <p>This OTP will expire in ${EMAIL_CONFIG.otpExpireTime}.</p>
`;

const generateSignInOTPEmailTemplate = (otp: string): string => `
  <p>We received a request to sign in. Please use the OTP below to verify your sign-in:</p>
  <p>Your OTP for sign-in is: <strong>${otp}</strong></p>
  <p>This OTP will expire in ${EMAIL_CONFIG.otpExpireTime}.</p>
`;

interface InvitationEmailProps {
  email: string;
  invitedByUsername: string;
  invitedByEmail: string;
  teamName: string;
  inviteLink: string;
}

interface InvitationWithCredentialsProps extends InvitationEmailProps {
  tempPassword: string;
}

const generateOrganizationInvitationEmailTemplate = ({
  invitedByUsername,
  invitedByEmail,
  teamName,
  inviteLink,
}: InvitationEmailProps): string => `
  <div style="background-color: #ffffff; color: #374151; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; text-align: center; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e5e7eb; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
    
    <!-- Workspace Initials Badge -->
    <div style="background-color: #06b6d4; color: #ffffff; width: 56px; height: 56px; line-height: 56px; border-radius: 16px; font-weight: bold; font-size: 20px; margin: 0 auto 24px auto; text-transform: uppercase; box-shadow: 0px 4px 12px rgba(6, 182, 212, 0.25);">
      ${teamName.substring(0, 2).toUpperCase()}
    </div>

    <!-- Main Message -->
    <h2 style="color: #1f2937; font-size: 20px; font-weight: 600; margin-bottom: 6px; line-height: 1.4;">
      ${invitedByUsername} has invited you to join
    </h2>
    <h1 style="color: #0891b2; font-size: 26px; font-weight: 700; margin-top: 0; margin-bottom: 20px;">
      ${teamName}
    </h1>

    <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin-bottom: 32px; padding: 0 15px;">
      ${invitedByUsername} (<span style="color: #1f2937; font-weight: 500;">${invitedByEmail}</span>) has requested to add you to their corporate firm portal workspace. Click below to review your permissions and activate your account.
    </p>

    <!-- Call to Action Button -->
    <div style="margin-bottom: 32px;">
      <a href="${inviteLink}" target="_blank" style="background-color: #2563eb; color: #ffffff; padding: 14px 32px; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; display: inline-block; box-shadow: 0px 4px 14px rgba(37, 99, 235, 0.3);">
        Accept Invitation
      </a>
    </div>

    <!-- Divider & Footer Context -->
    <hr style="border: 0; border-top: 1px solid #f3f4f6; margin-bottom: 20px;" />
    <p style="color: #9ca3af; font-size: 12px; line-height: 1.5; padding: 0 10px;">
      If you did not expect an invitation to this organization, you can safely ignore this email. This registration link routes securely to your firm's verification portal.
    </p>
  </div>
`;

const generateInvitationWithCredentialsTemplate = ({
  invitedByUsername,
  teamName,
  email,
  tempPassword,
  inviteLink,
}: InvitationWithCredentialsProps): string => `
  <div style="background-color: #ffffff; color: #374151; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; text-align: center; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e5e7eb; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">

    <div style="background-color: #06b6d4; color: #ffffff; width: 56px; height: 56px; line-height: 56px; border-radius: 16px; font-weight: bold; font-size: 20px; margin: 0 auto 24px auto; text-transform: uppercase; box-shadow: 0px 4px 12px rgba(6, 182, 212, 0.25);">
      ${teamName.substring(0, 2).toUpperCase()}
    </div>

    <h2 style="color: #1f2937; font-size: 20px; font-weight: 600; margin-bottom: 6px; line-height: 1.4;">
      Welcome to ${teamName}
    </h2>

    <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
      ${invitedByUsername} has created an account for you. Use the credentials below to sign in and accept your invitation.
    </p>

    <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px; text-align: left;">
      <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Sign-in email</p>
      <p style="margin: 0 0 16px; font-size: 15px; font-weight: 600; color: #1f2937;">${email}</p>
      <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Temporary password</p>
      <p style="margin: 0; font-size: 15px; font-weight: 600; color: #1f2937; font-family: 'Courier New', monospace; letter-spacing: 1px;">${tempPassword}</p>
    </div>

    <p style="color: #ef4444; font-size: 13px; line-height: 1.5; margin-bottom: 24px;">
      For security reasons, you will be required to set a new password after logging in.
    </p>

    <div style="margin-bottom: 16px;">
      <a href="${inviteLink}" target="_blank" style="background-color: #2563eb; color: #ffffff; padding: 14px 32px; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; display: inline-block; box-shadow: 0px 4px 14px rgba(37, 99, 235, 0.3);">
        Accept Invitation
      </a>
    </div>

    <p style="color: #9ca3af; font-size: 12px; line-height: 1.5; padding: 0 10px;">
      If you did not expect this invitation, you can safely ignore this email.
    </p>
  </div>
`;

const OTP_EMAIL_CONFIG: Record<
  VerificationOTPType,
  {
    subject: string;
    generateHtml: (otp: string) => string;
  }
> = {
  "sign-in": {
    subject: "Your Sign-In Verification Code",
    generateHtml: generateSignInOTPEmailTemplate,
  },
  "email-verification": {
    subject: "Verify Your Email Address",
    generateHtml: generateEmailVerificationOTPTemplate,
  },
  "forget-password": {
    subject: "Reset Your Password",
    generateHtml: generatePasswordResetOTPTemplate,
  },
  "change-email": {
    subject: "Verify Your New Email Address",
    generateHtml: generateChangeEmailVerificationTemplate,
  },
};

export class EmailService {
  private transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      service: EMAIL_CONFIG.service,
      auth: {
        user: env.SMTP_EMAIL_ADDRESS,
        pass: env.SMTP_PASSWORD,
      },
    });
  }

  async sendEmail(options: SendEmailOptions): Promise<void> {
    const mailOptions = { ...options, from: EMAIL_CONFIG.fromAddress };

    try {
      await this.transporter.sendMail(mailOptions);
      console.log(`Email sent to ${options.to}`);
    } catch (error) {
      console.error(`Failed to send email to ${options.to}:`, error);
      throw error;
    }
  }

  async sendVerificationEmail({
    email,
    url,
  }: SendAuthLinkEmailOptions): Promise<void> {
    await this.sendEmail({
      to: email,
      subject: EMAIL_CONFIG.verificationSubject,
      html: generateVerificationEmailTemplate(url),
    });
  }

  async sendPasswordResetEmail({
    email,
    url,
  }: SendAuthLinkEmailOptions): Promise<void> {
    await this.sendEmail({
      to: email,
      subject: EMAIL_CONFIG.passwordResetSubject,
      html: generatePasswordResetEmailTemplate(url),
    });
  }

  async sendVerificationOTP({
    email,
    otp,
    type,
  }: SendVerificationOTPOptions): Promise<void> {
    const otpEmail = OTP_EMAIL_CONFIG[type];

    await this.sendEmail({
      to: email,
      subject: otpEmail.subject,
      html: otpEmail.generateHtml(otp),
    });
  }

  async sendOrganizationInvitationEmail(
    props: InvitationEmailProps,
  ): Promise<void> {
    await this.sendEmail({
      to: props.email,
      subject: `Invitation to join ${props.teamName} on Oravanti`,
      html: generateOrganizationInvitationEmailTemplate(props),
    });
  }

  async sendInvitationWithCredentials(
    props: InvitationWithCredentialsProps,
  ): Promise<void> {
    await this.sendEmail({
      to: props.email,
      subject: `Welcome to ${props.teamName} — Your account is ready`,
      html: generateInvitationWithCredentialsTemplate(props),
    });
  }
}

export const emailService = new EmailService();
