import { google } from "googleapis";
import { env } from "../../config/env";
import { OAuthTokenProvider } from "./base";

export class GoogleTokenProvider extends OAuthTokenProvider {
  protected getClientId(): string {
    return env.GOOGLE_CLIENT_ID;
  }

  protected getClientSecret(): string {
    return env.GOOGLE_CLIENT_SECRET;
  }

  protected async refreshAccessToken(
    refreshToken: string,
  ) {
    const oauth = new google.auth.OAuth2({
      clientId: this.getClientId(),
      clientSecret: this.getClientSecret(),
    });
    oauth.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oauth.refreshAccessToken();
    return {
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      expiry_date: credentials.expiry_date,
    };
  }
}

export const googleTokenProvider = new GoogleTokenProvider();
