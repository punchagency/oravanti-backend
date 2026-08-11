import { env } from "../config/env";

/**
 * Derives the portal URL for a given account type from FRONTEND_APP_URL.
 *
 * - "client"  → https://clients.{root}  (or http://clients.localhost:5173)
 * - anything else → https://app.{root}   (or http://app.localhost:5173)
 *
 * Mirrors the frontend's getPortalUrl() in useSignInWithEmail.ts.
 */
export function getPortalUrl(accountType?: string | null): string {
  const frontendUrl = env.FRONTEND_APP_URL;
  const url = new URL(frontendUrl);
  const hostname = url.hostname;
  const port = url.port ? `:${url.port}` : "";
  const protocol = url.protocol;

  if (hostname.includes("localhost") || hostname.includes("127.0.0.1")) {
    if (accountType === "client") {
      return `${protocol}//clients.localhost${port}`;
    }
    return `${protocol}//app.localhost${port}`;
  }

  const parts = hostname.split(".");
  if (parts.length > 1) {
    const root = parts.slice(1).join(".");
    if (accountType === "client") {
      return `${protocol}//clients.${root}`;
    }
    return `${protocol}//app.${root}`;
  }

  return frontendUrl;
}

/**
 * Returns the email verification callback URL for a given account type.
 */
export function getEmailVerificationCallbackUrl(
  accountType?: string | null,
): string {
  return `${getPortalUrl(accountType)}/email-verified`;
}
