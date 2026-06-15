import { symmetricDecrypt } from "better-auth/crypto";
import { desc, eq } from "drizzle-orm";
import { google } from "googleapis";
import type { BetterAuthOptions } from "better-auth";
import { db } from "../db/client";
import { member, session } from "../db/schema/auth-schema";
import { connectedEmailAccount } from "../db/schema/email";
import { getActiveOrganization } from "./helpers";

const secret = process.env.BETTER_AUTH_SECRET!;

export const databaseHooks = {
  account: {
    create: {
      after: async (account: any) => {
        if (account.providerId !== "google") return;
        if (!account.accessToken) return;

        try {
          let email = "";

          // 1. Decode email from Google ID token
          if (account.idToken) {
            try {
              const payload = account.idToken.split(".")[1];
              const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
              const decoded = JSON.parse(
                Buffer.from(base64, "base64").toString(),
              );
              email = decoded.email || "";
            } catch {}
          }

          // 2. Fallback: decrypt token and fetch email from Google API
          if (!email) {
            try {
              const decryptedToken = await symmetricDecrypt({
                key: secret,
                data: account.accessToken,
              }).catch(() => account.accessToken);
              const auth = new google.auth.OAuth2();
              auth.setCredentials({ access_token: decryptedToken });
              const { data } = await auth.request({
                url: "https://www.googleapis.com/oauth2/v2/userinfo",
              });
              email = (data as any).email || "";
            } catch {}
          }

          if (!email) return;

          // 3. Get org from user's active session, fall back to first membership
          let orgId: string | null = null;

          const [latestSession] = await db
            .select({ activeOrganizationId: session.activeOrganizationId })
            .from(session)
            .where(eq(session.userId, account.userId))
            .orderBy(desc(session.createdAt))
            .limit(1);

          if (latestSession?.activeOrganizationId) {
            orgId = latestSession.activeOrganizationId;
          } else {
            const [membership] = await db
              .select({ organizationId: member.organizationId })
              .from(member)
              .where(eq(member.userId, account.userId))
              .limit(1);
            orgId = membership?.organizationId || null;
          }

          if (!orgId) return;

          // 4. Save to connectedEmailAccount
          await db
            .insert(connectedEmailAccount)
            .values({
              userId: account.userId,
              organizationId: orgId,
              email,
              provider: "google",
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
          console.error(
            "Failed to connect Google email account via Better Auth hook:",
            e,
          );
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
} satisfies BetterAuthOptions["databaseHooks"];
