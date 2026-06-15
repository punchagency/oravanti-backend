import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { connectedEmailAccount } from "../../db/schema/email";

const secret = process.env.BETTER_AUTH_SECRET!;

export interface TokenCredentials {
  access_token: string | null | undefined;
  refresh_token?: string | null | undefined;
  expiry_date?: number | null | undefined;
}

export abstract class OAuthTokenProvider {
  protected abstract getClientId(): string;
  protected abstract getClientSecret(): string;

  protected async decrypt(token: string | null | undefined) {
    if (!token) return token;
    try {
      return await symmetricDecrypt({ key: secret, data: token });
    } catch {
      return token;
    }
  }

  protected async encrypt(token: string | null | undefined) {
    if (!token) return token;
    try {
      return await symmetricEncrypt({ key: secret, data: token });
    } catch {
      return token;
    }
  }

  protected abstract refreshAccessToken(
    refreshToken: string,
  ): Promise<TokenCredentials>;

  protected shouldRefresh(
    accessToken: string | null | undefined,
    expiresAt: Date | null | undefined,
  ): boolean {
    if (!accessToken) return true;
    if (!expiresAt) return false;
    const bufferTime = 5 * 60 * 1000;
    return expiresAt.getTime() - bufferTime <= Date.now();
  }

  protected async persistTokens(
    connectionId: string,
    credentials: TokenCredentials,
    previousRefreshToken: string,
  ) {
    const update: Record<string, any> = {};

    if (credentials.access_token) {
      update.accessToken = await this.encrypt(credentials.access_token);
    }
    if (
      credentials.refresh_token &&
      credentials.refresh_token !== previousRefreshToken
    ) {
      update.refreshToken = await this.encrypt(credentials.refresh_token);
    }
    if (credentials.expiry_date) {
      update.expiresAt = new Date(credentials.expiry_date);
    }

    if (Object.keys(update).length > 0) {
      await db
        .update(connectedEmailAccount)
        .set(update)
        .where(eq(connectedEmailAccount.id, connectionId));
    }
  }

  async getValidAccessToken(connectionId: string): Promise<string> {
    const [connection] = await db
      .select()
      .from(connectedEmailAccount)
      .where(eq(connectedEmailAccount.id, connectionId));

    if (!connection) throw new Error("Email connection profile missing.");

    const rawAccessToken = await this.decrypt(connection.accessToken);
    const rawRefreshToken = await this.decrypt(connection.refreshToken);

    if (!this.shouldRefresh(rawAccessToken, connection.expiresAt)) {
      return rawAccessToken!;
    }

    if (!rawRefreshToken) {
      throw new Error("No refresh token available for this email connection.");
    }

    const credentials = await this.refreshAccessToken(rawRefreshToken);

    await this.persistTokens(connectionId, credentials, rawRefreshToken);

    return credentials.access_token!;
  }
}
