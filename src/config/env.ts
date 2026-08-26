import "dotenv/config";

const REQUIRED_ENV_KEYS = [
  "NODE_ENV",
  "PORT",
  "CORS_ORIGIN",
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "SMTP_EMAIL_ADDRESS",
  "SMTP_PASSWORD",
  "SERVER_MASTER_KEY_PRIMARY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "EMAIL_ENCRYPTION_KEY",
  "PAYMENT_ENCRYPTION_KEY",
  "EMAIL_VERIFICATION_CALLBACK_URL",
  "FRONTEND_APP_URL",
  "REDIS_URL"
] as const;

type RequiredEnvKey = (typeof REQUIRED_ENV_KEYS)[number];

type AppEnv = Record<RequiredEnvKey, string> & {
  PROD_DATABASE_URL?: string;
  SERVER_MASTER_KEY_OLD?: string;
  CONTRACTOR_PAYMENT_ENCRYPTION_KEY?: string;
  RESEND_API_KEY?: string;
  // Platform-owned Google Workspace service account used to mint Google Meet
  // links for all firms. Optional: when unset the Meet service falls back to a
  // placeholder link so non-Workspace/dev environments still function.
  GOOGLE_MEET_CLIENT_EMAIL?: string;
  GOOGLE_MEET_PRIVATE_KEY?: string;
  GOOGLE_MEET_IMPERSONATED_USER?: string;
  // Platform-owned Dropbox Sign (HelloSign) account, shared across all firms.
  // Optional: when the API key/client id are unset the leads module falls back
  // to the stub e-signature provider so dev environments still function.
  DROPBOX_SIGN_API_KEY?: string;
  DROPBOX_SIGN_CLIENT_ID?: string;
  /**
   * Stripe. Unset everywhere today: the finance module falls back to a stub
   * provider that records nothing and says so out loud.
   *
   * The secret and the webhook secret are required TOGETHER —
   * `isPaymentProviderConfigured()` demands both. A secret key with no webhook
   * secret would leave a public endpoint unable to verify what it is sent while
   * the rest of the system believed payments were live.
   */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  /**
   * Platform-owned Twilio account and Messaging Service, shared across every
   * firm — the same arrangement as Dropbox Sign above. Unset everywhere today:
   * the notification layer falls back to a stub SMS provider that logs and
   * sends nothing, and `consultation_settings.sms_enabled` defaults to false on
   * top of that.
   *
   * The SID and the auth token are required TOGETHER, and so is a sender.
   * `isSmsProviderConfigured()` demands all three. The auth token is also what
   * verifies the status and inbound webhooks, so a configured sender without it
   * would leave two public endpoints unable to check what they are sent while
   * the rest of the system believed SMS was live — the same reasoning as
   * STRIPE_WEBHOOK_SECRET.
   */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** Preferred sender: gives sender pools, sticky sender and Advanced Opt-Out. */
  TWILIO_MESSAGING_SERVICE_SID?: string;
  /** Single-number fallback for local and trial use, when no Messaging Service is set. */
  TWILIO_FROM_NUMBER?: string;
  /**
   * The EXACT public base URL Twilio is configured to call.
   *
   * Twilio's signature is an HMAC over the request URL plus its sorted form
   * params, so the URL must be reproduced byte for byte. Rebuilding it from
   * `req.protocol` fails behind a proxy — the app sees "http" while Twilio
   * signed "https" — and every legitimate request is rejected as forged.
   */
  TWILIO_WEBHOOK_BASE_URL?: string;
  /**
   * Svix signing secret for Resend's delivery webhooks. Required alongside
   * RESEND_API_KEY for `isEmailDeliveryTrackingConfigured()`; without it the
   * webhook endpoint cannot verify anything and email rows simply stop at
   * "sent" instead of reaching "delivered".
   */
  RESEND_WEBHOOK_SECRET?: string;
  /**
   * Optional ISO-3166 region ("US") used to parse bare national phone numbers.
   * Left unset by default so an ambiguous number fails loudly as unsendable
   * rather than being silently attributed to the wrong country.
   */
  PHONE_DEFAULT_REGION?: string;
  /**
   * Which SMS vendor sends. "twilio" | "telnyx", case-insensitive.
   *
   * Deliberately typed `string` and not narrowed here: everything validateEnv
   * validates, it THROWS on, and an unrecognised provider must fall back to the
   * stub rather than take the process down. Recognition happens in
   * sms.provider.ts, which warns rather than throws.
   *
   * This is the rollback switch. A problem with one vendor is one env var and a
   * restart — both webhook routes stay mounted whatever this says, so callbacks
   * for messages already in flight are still accepted during a switchover.
   */
  SMS_PROVIDER?: string;
  /**
   * Platform-owned Telnyx account and Messaging Profile, shared across every
   * firm — the same arrangement as Twilio above.
   *
   * TELNYX_PUBLIC_KEY is NOT optional when Telnyx is active. Telnyx verifies
   * webhooks with a public key that is a different value from a different page
   * of the portal than the API key, so it is the one credential that can be
   * forgotten while sending still works — and its absence would mean every
   * opt-out signal is rejected as forged.
   */
  TELNYX_API_KEY?: string;
  TELNYX_MESSAGING_PROFILE_ID?: string;
  TELNYX_FROM_NUMBER?: string;
  TELNYX_PUBLIC_KEY?: string;
  TELNYX_WEBHOOK_BASE_URL?: string;
  /**
   * Confido Legal — the processor that replaces Stripe, chosen because it routes
   * a single client payment into separate trust (IOLTA) and operating bank
   * accounts, which Stripe cannot do.
   *
   * The partner token and the webhook secret are required TOGETHER, for the same
   * reason as Stripe's pair above: a partner token with no webhook secret would
   * leave a public endpoint unable to verify what it is sent.
   *
   * The partner token is the platform-level credential used to create Firms. Each
   * Firm then gets its own long-lived, unscoped API token, which is stored
   * per-organization and encrypted at rest — never here.
   */
  CONFIDO_PARTNER_TOKEN?: string;
  CONFIDO_WEBHOOK_SECRET?: string;
  CONFIDO_API_URL?: string;
  /**
   * The onboarding.js bundle the frontend embeds. Deliberately a backend value
   * returned in the session payload rather than a `VITE_` variable: it keeps one
   * source of truth for the sandbox/production switch, so the frontend never has
   * to know which environment it is pointed at.
   */
  CONFIDO_ONBOARDING_JS_URL?: string;
  // When true (default outside production) signature requests are created in
  // test mode and do not consume signature quota.
  DROPBOX_SIGN_TEST_MODE: boolean;
  // Dev-only escape hatch: skips the "payment received" requirement on the
  // case-opening gate for non-contingency fee agreements. Never active in
  // production.
  FEE_PAYMENT_GATE_BYPASS: boolean;
  databaseUrl: string;
  isProduction: boolean;
};

const readEnv = (key: string) => {
  const value = process.env[key];

  if (!value?.trim()) {
    return undefined;
  }

  return value.trim();
};

const validateEnv = (): AppEnv => {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !readEnv(key));

  if (missing.length) {
    throw new Error(
      `Missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }

  const values = REQUIRED_ENV_KEYS.reduce(
    (acc, key) => {
      acc[key] = readEnv(key)!;
      return acc;
    },
    {} as Record<RequiredEnvKey, string>,
  );

  const port = Number(values.PORT);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }

  const isProduction = values.NODE_ENV === "production";
  const prodDatabaseUrl = readEnv("PROD_DATABASE_URL");
  const serverMasterKeyOld = readEnv("SERVER_MASTER_KEY_OLD");
  const contractorPaymentEncryptionKey = readEnv("CONTRACTOR_PAYMENT_ENCRYPTION_KEY");

  if (isProduction && !prodDatabaseUrl) {
    throw new Error("Missing required environment variable: PROD_DATABASE_URL");
  }

  const resendApiKey = readEnv("RESEND_API_KEY");
  const googleMeetClientEmail = readEnv("GOOGLE_MEET_CLIENT_EMAIL");
  const googleMeetPrivateKey = readEnv("GOOGLE_MEET_PRIVATE_KEY");
  const googleMeetImpersonatedUser = readEnv("GOOGLE_MEET_IMPERSONATED_USER");
  const stripeSecretKey = readEnv("STRIPE_SECRET_KEY");
  const stripeWebhookSecret = readEnv("STRIPE_WEBHOOK_SECRET");
  const stripePublishableKey = readEnv("STRIPE_PUBLISHABLE_KEY");
  const confidoPartnerToken = readEnv("CONFIDO_PARTNER_TOKEN");
  const confidoWebhookSecret = readEnv("CONFIDO_WEBHOOK_SECRET");
  const confidoApiUrl = readEnv("CONFIDO_API_URL");
  const confidoOnboardingJsUrl = readEnv("CONFIDO_ONBOARDING_JS_URL");
  const dropboxSignApiKey = readEnv("DROPBOX_SIGN_API_KEY");
  const dropboxSignClientId = readEnv("DROPBOX_SIGN_CLIENT_ID");
  const twilioAccountSid = readEnv("TWILIO_ACCOUNT_SID");
  const twilioAuthToken = readEnv("TWILIO_AUTH_TOKEN");
  const twilioMessagingServiceSid = readEnv("TWILIO_MESSAGING_SERVICE_SID");
  const twilioFromNumber = readEnv("TWILIO_FROM_NUMBER");
  const twilioWebhookBaseUrl = readEnv("TWILIO_WEBHOOK_BASE_URL");
  const resendWebhookSecret = readEnv("RESEND_WEBHOOK_SECRET");
  const phoneDefaultRegion = readEnv("PHONE_DEFAULT_REGION");
  // Lowercased: SMS_PROVIDER=Twilio silently falling back to the stub would be
  // a nasty production incident.
  const smsProvider = readEnv("SMS_PROVIDER")?.toLowerCase();
  const telnyxApiKey = readEnv("TELNYX_API_KEY");
  const telnyxMessagingProfileId = readEnv("TELNYX_MESSAGING_PROFILE_ID");
  const telnyxFromNumber = readEnv("TELNYX_FROM_NUMBER");
  const telnyxPublicKey = readEnv("TELNYX_PUBLIC_KEY");
  const telnyxWebhookBaseUrl = readEnv("TELNYX_WEBHOOK_BASE_URL");
  // Defaults to test mode everywhere except production so quota is never
  // consumed accidentally; set DROPBOX_SIGN_TEST_MODE=false to override.
  const dropboxSignTestMode = isProduction
    ? readEnv("DROPBOX_SIGN_TEST_MODE") === "true"
    : readEnv("DROPBOX_SIGN_TEST_MODE") !== "false";
  // Opt-in and forced off in production.
  const feePaymentGateBypass =
    !isProduction && readEnv("FEE_PAYMENT_GATE_BYPASS") === "true";

  return {
    ...values,
    ...(prodDatabaseUrl ? { PROD_DATABASE_URL: prodDatabaseUrl } : {}),
    ...(serverMasterKeyOld ? { SERVER_MASTER_KEY_OLD: serverMasterKeyOld } : {}),
    ...(contractorPaymentEncryptionKey ? { CONTRACTOR_PAYMENT_ENCRYPTION_KEY: contractorPaymentEncryptionKey } : {}),
    ...(resendApiKey ? { RESEND_API_KEY: resendApiKey } : {}),
    ...(googleMeetClientEmail ? { GOOGLE_MEET_CLIENT_EMAIL: googleMeetClientEmail } : {}),
    ...(googleMeetPrivateKey ? { GOOGLE_MEET_PRIVATE_KEY: googleMeetPrivateKey } : {}),
    ...(googleMeetImpersonatedUser ? { GOOGLE_MEET_IMPERSONATED_USER: googleMeetImpersonatedUser } : {}),
    ...(stripeSecretKey ? { STRIPE_SECRET_KEY: stripeSecretKey } : {}),
    ...(stripeWebhookSecret ? { STRIPE_WEBHOOK_SECRET: stripeWebhookSecret } : {}),
    ...(stripePublishableKey
      ? { STRIPE_PUBLISHABLE_KEY: stripePublishableKey }
      : {}),
    ...(confidoPartnerToken
      ? { CONFIDO_PARTNER_TOKEN: confidoPartnerToken }
      : {}),
    ...(confidoWebhookSecret
      ? { CONFIDO_WEBHOOK_SECRET: confidoWebhookSecret }
      : {}),
    ...(confidoApiUrl ? { CONFIDO_API_URL: confidoApiUrl } : {}),
    ...(confidoOnboardingJsUrl
      ? { CONFIDO_ONBOARDING_JS_URL: confidoOnboardingJsUrl }
      : {}),
    ...(dropboxSignApiKey ? { DROPBOX_SIGN_API_KEY: dropboxSignApiKey } : {}),
    ...(dropboxSignClientId ? { DROPBOX_SIGN_CLIENT_ID: dropboxSignClientId } : {}),
    ...(twilioAccountSid ? { TWILIO_ACCOUNT_SID: twilioAccountSid } : {}),
    ...(twilioAuthToken ? { TWILIO_AUTH_TOKEN: twilioAuthToken } : {}),
    ...(twilioMessagingServiceSid
      ? { TWILIO_MESSAGING_SERVICE_SID: twilioMessagingServiceSid }
      : {}),
    ...(twilioFromNumber ? { TWILIO_FROM_NUMBER: twilioFromNumber } : {}),
    ...(twilioWebhookBaseUrl
      ? { TWILIO_WEBHOOK_BASE_URL: twilioWebhookBaseUrl }
      : {}),
    ...(resendWebhookSecret
      ? { RESEND_WEBHOOK_SECRET: resendWebhookSecret }
      : {}),
    ...(phoneDefaultRegion ? { PHONE_DEFAULT_REGION: phoneDefaultRegion } : {}),
    ...(smsProvider ? { SMS_PROVIDER: smsProvider } : {}),
    ...(telnyxApiKey ? { TELNYX_API_KEY: telnyxApiKey } : {}),
    ...(telnyxMessagingProfileId
      ? { TELNYX_MESSAGING_PROFILE_ID: telnyxMessagingProfileId }
      : {}),
    ...(telnyxFromNumber ? { TELNYX_FROM_NUMBER: telnyxFromNumber } : {}),
    ...(telnyxPublicKey ? { TELNYX_PUBLIC_KEY: telnyxPublicKey } : {}),
    ...(telnyxWebhookBaseUrl
      ? { TELNYX_WEBHOOK_BASE_URL: telnyxWebhookBaseUrl }
      : {}),
    DROPBOX_SIGN_TEST_MODE: dropboxSignTestMode,
    FEE_PAYMENT_GATE_BYPASS: feePaymentGateBypass,
    databaseUrl: isProduction ? prodDatabaseUrl! : values.DATABASE_URL,
    isProduction,
  };
};

export const env = validateEnv();
