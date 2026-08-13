export type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

export type SendEmailOptions = {
  to: string;
  subject: string;
  html: string;
  /**
   * Optional, so every existing caller is unaffected. Nodemailer accepts this
   * shape directly; the Resend provider maps it explicitly.
   */
  attachments?: EmailAttachment[];
};

export type SendAuthLinkEmailOptions = {
  email: string;
  url: string;
};

export type VerificationOTPType =
  "sign-in" | "email-verification" | "forget-password" | "change-email";

export type SendVerificationOTPOptions = {
  email: string;
  otp: string;
  type: VerificationOTPType;
};

export interface InvitationEmailProps {
  email: string;
  invitedByUsername: string;
  invitedByEmail: string;
  orgName: string;
  inviteLink: string;
}

export interface InvitationWithCredentialsProps extends InvitationEmailProps {
  tempPassword: string;
}

export abstract class BaseEmailService {
  abstract sendEmail(options: SendEmailOptions): Promise<void>;

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
      subject: `Invitation to join ${props.orgName} on Oravanti`,
      html: generateOrganizationInvitationEmailTemplate(props),
    });
  }

  async sendInvitationWithCredentials(
    props: InvitationWithCredentialsProps,
  ): Promise<void> {
    await this.sendEmail({
      to: props.email,
      subject: `Welcome to ${props.orgName} — Your account is ready`,
      html: generateInvitationWithCredentialsTemplate(props),
    });
  }
}

export const EMAIL_CONFIG = {
  fromAddress: "noreply@staging.oravanti.com",
  verificationSubject: "Verify Your Email Address",
  passwordResetSubject: "Reset Your Password",
  verificationExpireTime: "30 minutes",
  passwordResetExpireTime: "30 minutes",
  otpExpireTime: "5 minutes",
} as const;

const authLinkButtonStyle =
  "display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0;";

const authLinkShellStyle = "font-family: Arial, sans-serif; color: #333;";

export const generateVerificationEmailTemplate = (url: string): string => `
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

export const generatePasswordResetEmailTemplate = (url: string): string => `
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

export const generateEmailVerificationOTPTemplate = (otp: string): string => `
  <p>Thank you for signing up!</p>
  <p>Please use the OTP below to verify your email address:</p>
  <p>Your OTP is: <strong>${otp}</strong></p>
  <p>This OTP will expire in ${EMAIL_CONFIG.otpExpireTime}.</p>
`;

export const generatePasswordResetOTPTemplate = (otp: string): string => `
  <p>We received a request to reset your password. Please use the OTP below to verify your new password:</p>
  <p>Your OTP for password reset is: <strong>${otp}</strong></p>
  <p>This OTP will expire in ${EMAIL_CONFIG.otpExpireTime}.</p>
`;

export const generateChangeEmailVerificationTemplate = (
  otp: string,
): string => `
  <p>We received a request to change your email address. Please use the OTP below to verify your new email address:</p>
  <p>Your OTP for changing email is: <strong>${otp}</strong></p>
  <p>This OTP will expire in ${EMAIL_CONFIG.otpExpireTime}.</p>
`;

export const generateSignInOTPEmailTemplate = (otp: string): string => `
  <p>We received a request to sign in. Please use the OTP below to verify your sign-in:</p>
  <p>Your OTP for sign-in is: <strong>${otp}</strong></p>
  <p>This OTP will expire in ${EMAIL_CONFIG.otpExpireTime}.</p>
`;

export const generateOrganizationInvitationEmailTemplate = ({
  invitedByUsername,
  invitedByEmail,
  orgName,
  inviteLink,
}: InvitationEmailProps): string => `
  <div style="background-color: #ffffff; color: #374151; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; text-align: center; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e5e7eb; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
    
    <!-- Workspace Initials Badge -->
    <div style="background-color: #06b6d4; color: #ffffff; width: 56px; height: 56px; line-height: 56px; border-radius: 16px; font-weight: bold; font-size: 20px; margin: 0 auto 24px auto; text-transform: uppercase; box-shadow: 0px 4px 12px rgba(6, 182, 212, 0.25);">
      ${orgName.substring(0, 2).toUpperCase()}
    </div>

    <!-- Main Message -->
    <h2 style="color: #1f2937; font-size: 20px; font-weight: 600; margin-bottom: 6px; line-height: 1.4;">
      ${invitedByUsername} has invited you to join
    </h2>
    <h1 style="color: #0891b2; font-size: 26px; font-weight: 700; margin-top: 0; margin-bottom: 20px;">
      ${orgName}
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

export const generateInvitationWithCredentialsTemplate = ({
  invitedByUsername,
  orgName,
  email,
  tempPassword,
  inviteLink,
}: InvitationWithCredentialsProps): string => `
  <div style="background-color: #ffffff; color: #374151; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; text-align: center; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e5e7eb; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">

    <div style="background-color: #06b6d4; color: #ffffff; width: 56px; height: 56px; line-height: 56px; border-radius: 16px; font-weight: bold; font-size: 20px; margin: 0 auto 24px auto; text-transform: uppercase; box-shadow: 0px 4px 12px rgba(6, 182, 212, 0.25);">
      ${orgName.substring(0, 2).toUpperCase()}
    </div>

    <h2 style="color: #1f2937; font-size: 20px; font-weight: 600; margin-bottom: 6px; line-height: 1.4;">
      Welcome to ${orgName}
    </h2>

    <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
      ${invitedByUsername} has created an account for you. Click below to sign in with your credentials.
    </p>

    <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px; text-align: left;">
      <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Sign-in email</p>
      <p style="margin: 0 0 16px; font-size: 15px; font-weight: 600; color: #1f2937;">${email}</p>
      <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Temporary password</p>
      <p style="margin: 0; font-size: 15px; font-weight: 600; color: #1f2937; font-family: 'Courier New', monospace; letter-spacing: 1px;">${tempPassword}</p>
    </div>

    <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin-bottom: 24px;">
      We recommend changing your password after signing in for added security.
    </p>

    <div style="margin-bottom: 16px;">
      <a href="${inviteLink}" target="_blank" style="background-color: #2563eb; color: #ffffff; padding: 14px 32px; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; display: inline-block; box-shadow: 0px 4px 14px rgba(37, 99, 235, 0.3);">
        Sign in to your account
      </a>
    </div>

    <p style="color: #9ca3af; font-size: 12px; line-height: 1.5; padding: 0 10px;">
      If you did not expect this invitation, you can safely ignore this email.
    </p>
  </div>
`;

export type DocumentRequestEmailProps = {
  /** Who the request is about, e.g. "Dear Maria". */
  recipientName?: string | null;
  firmName: string;
  /** What is being asked for, e.g. "Birth Certificate". */
  requestedLabel: string;
  /** Why, in the reviewer-facing prose the AI review already renders. */
  reason: string;
  uploadLink: string;
  expiresAt: Date;
};

/**
 * The email behind "Request re-upload" / "Send client reminder".
 *
 * The point of this template over a bare paragraph is that the recipient can
 * act: it names the document, says why it is needed, and carries the upload
 * link. Structure follows the invitation-with-credentials template — the grey
 * panel is where the specifics go.
 */
export const generateDocumentRequestEmailTemplate = ({
  recipientName,
  firmName,
  requestedLabel,
  reason,
  uploadLink,
  expiresAt,
}: DocumentRequestEmailProps): string => `
  <div style="background-color: #ffffff; color: #374151; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; text-align: center; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid #e5e7eb; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">

    <div style="background-color: #06b6d4; color: #ffffff; width: 56px; height: 56px; line-height: 56px; border-radius: 16px; font-weight: bold; font-size: 20px; margin: 0 auto 24px auto; text-transform: uppercase; box-shadow: 0px 4px 12px rgba(6, 182, 212, 0.25);">
      ${firmName.substring(0, 2).toUpperCase()}
    </div>

    <h2 style="color: #1f2937; font-size: 20px; font-weight: 600; margin-bottom: 6px; line-height: 1.4;">
      ${recipientName ? `${recipientName}, a` : "A"} document is needed
    </h2>

    <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
      ${firmName} needs a document from you to keep your matter moving.
    </p>

    <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 24px; text-align: left;">
      <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Document requested</p>
      <p style="margin: 0 0 16px; font-size: 15px; font-weight: 600; color: #1f2937;">${requestedLabel}</p>
      <p style="margin: 0 0 8px; font-size: 13px; color: #6b7280;">Why it is needed</p>
      <p style="margin: 0; font-size: 14px; color: #1f2937; line-height: 1.5;">${reason}</p>
    </div>

    <div style="margin-bottom: 16px;">
      <a href="${uploadLink}" target="_blank" style="background-color: #2563eb; color: #ffffff; padding: 14px 32px; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 8px; display: inline-block; box-shadow: 0px 4px 14px rgba(37, 99, 235, 0.3);">
        Upload document
      </a>
    </div>

    <p style="color: #9ca3af; font-size: 12px; line-height: 1.5; padding: 0 10px;">
      This link is unique to you — please do not share it. It expires on ${expiresAt.toDateString()}.
    </p>
  </div>
`;

export const OTP_EMAIL_CONFIG: Record<
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
