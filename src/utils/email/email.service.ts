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
}

export const emailService = new EmailService();
