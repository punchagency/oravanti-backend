import { OAuthTokenProvider, type TokenCredentials } from "./base";

export class MicrosoftTokenProvider extends OAuthTokenProvider {
  private tenantId: string;

  constructor(tenantId = "common") {
    super();
    this.tenantId = tenantId;
  }

  protected getClientId(): string {
    return process.env.MICROSOFT_CLIENT_ID!;
  }

  protected getClientSecret(): string {
    return process.env.MICROSOFT_CLIENT_SECRET!;
  }

  protected async refreshAccessToken(
    refreshToken: string,
  ): Promise<TokenCredentials> {
    const params = new URLSearchParams({
      client_id: this.getClientId(),
      client_secret: this.getClientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetch(
      `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Microsoft token refresh failed (${response.status}): ${body}`,
      );
    }

    const data = await response.json();

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expiry_date: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : undefined,
    };
  }
}

export const microsoftTokenProvider = new MicrosoftTokenProvider();
