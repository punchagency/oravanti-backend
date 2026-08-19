import type { BetterAuthOptions } from "better-auth";
import { symmetricDecrypt } from "better-auth/crypto";
import { desc, eq } from "drizzle-orm";
import { google } from "googleapis";
import { env } from "../config/env";
import { systemDb } from "../db/client";
import { staff } from "../db/schema";
import { member, session } from "../db/schema/auth-schema";
import { connectedEmailAccount } from "../db/schema/email";
import { createModuleLogger } from "../lib/logging/log";
import { getActiveOrganization } from "./helpers";

const secret = env.BETTER_AUTH_SECRET;
const log = createModuleLogger("auth.database_hooks");

function extractEmailFromIdToken(idToken: string): string | null {
  try {
    const payload = idToken.split(".")[1];
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(Buffer.from(base64, "base64").toString());
    return decoded.email || decoded.preferred_username || decoded.upn || null;
  } catch {
    return null;
  }
}

async function getOrgId(userId: string) {
  const [latestSession] = await systemDb
    .select({ activeOrganizationId: session.activeOrganizationId })
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(desc(session.createdAt))
    .limit(1);

  if (latestSession?.activeOrganizationId) {
    return latestSession.activeOrganizationId;
  }

  const [membership] = await systemDb
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);

  return membership?.organizationId || null;
}

export const databaseHooks = {
  user: {
    create: {
      before: async (data: any) => {
        if (data.accountType === "client") {
          return {
            data: { ...data, emailVerified: true },
          };
        }
        return { data };
      },
    },
    update: {
      after: async (user) => {
        await systemDb
          .update(staff)
          .set({ email: user.email })
          .where(eq(staff.userId, user.id));
      },
    },
  },
  account: {
    create: {
      after: async (account: any) => {
        if (
          account.providerId !== "google" &&
          account.providerId !== "microsoft"
        )
          return;

        if (!account.accessToken) return;

        try {
          const provider = account.providerId as "google" | "microsoft";
          let email = "";

          // 1. Decode email from ID token
          if (account.idToken) {
            email = extractEmailFromIdToken(account.idToken) || "";
          }

          // 2. Fallback: decrypt token and fetch email from provider API
          if (!email) {
            try {
              const decryptedToken = await symmetricDecrypt({
                key: secret,
                data: account.accessToken,
              }).catch(() => account.accessToken);

              if (provider === "google") {
                const auth = new google.auth.OAuth2();
                auth.setCredentials({ access_token: decryptedToken });
                const { data } = await auth.request({
                  url: "https://www.googleapis.com/oauth2/v2/userinfo",
                });
                email = (data as any).email || "";
              } else {
                const response = await fetch(
                  "https://graph.microsoft.com/v1.0/me",
                  {
                    headers: { Authorization: `Bearer ${decryptedToken}` },
                  },
                );
                if (response.ok) {
                  const data = await response.json();
                  email = data.mail || data.userPrincipalName || "";
                }
              }
            } catch {
              // Best effort. The email is resolved again from the ID token
              // on the next sign-in, and failing the whole hook because a
              // profile fetch timed out would block the login itself.
            }
          }

          if (!email) return;

          const orgId = await getOrgId(account.userId);
          if (!orgId) return;

          // 3. Save to connectedEmailAccount
          await systemDb
            .insert(connectedEmailAccount)
            .values({
              userId: account.userId,
              organizationId: orgId,
              email,
              provider,
              accessToken: account.accessToken,
              refreshToken: account.refreshToken,
              expiresAt: account.accessTokenExpiresAt,
              providerAccountId: account.accountId,
            })
            .onConflictDoUpdate({
              target: connectedEmailAccount.email,
              set: {
                accessToken: account.accessToken,
                refreshToken: account.refreshToken,
                expiresAt: account.accessTokenExpiresAt,
              },
            });
        } catch (e) {
          // Swallowed so sign-in still succeeds — but the user's mailbox is
          // silently not connected, so it has to be visible somewhere.
          log.failure("email_account.link_failed", e, {
            provider: account.providerId,
            targetUserId: account.userId,
          });
        }
      },
    },
  },
  session: {
    create: {
      before: async (session: any) => {
        const organization = await getActiveOrganization(session.userId);

        const ipAddress = session.ipAddress;
        let locationStr = "Unknown Location";

        // Bypass localhost/internal IPs during development
        if (ipAddress && ipAddress !== "::1" && ipAddress !== "127.0.0.1") {
          try {
            const response = await fetch(`http://ip-api.com/json/${ipAddress}`);
            const data = await response.json();

            // The bare `console.log(data)` that was here dumped the whole
            // third-party response — which carries the user's ISP, latitude,
            // longitude, postcode and organisation — into the log on every
            // single sign-in. Only the two fields actually used are recorded.
            if (!data.error && data.city && data.country) {
              locationStr = `${data.city}, ${data.country}`;
            }
          } catch (error) {
            // Best effort. The session is created either way, with the
            // location left as "Unknown Location".
            log.warn("auth.geo_lookup_failed", {
              err: error,
              targetUserId: session.userId,
            });
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
} satisfies BetterAuthOptions["databaseHooks"];
