import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../../config/env";
import { ExternalServiceError } from "../../../utils/error/app-error";
import type {
  ConfidoBankAccount,
  ConfidoBrandingInput,
  ConfidoCreateFirmResult,
  ConfidoExchangeCodeResult,
  ConfidoFirmSnapshot,
  ConfidoOnboardingToken,
} from "./confido.types";

/**
 * Confido Legal's GraphQL API.
 *
 * Shaped on `DropboxSignProvider` — raw fetch, no SDK, credentials by
 * constructor, one private request helper that turns every failure into
 * `ExternalServiceError`. Two things differ, both because this is GraphQL:
 *
 *   1. **A failed mutation still answers HTTP 200**, with the failure in an
 *      `errors` array. Checking `res.ok` alone reports it as success, which is
 *      how a firm ends up looking created when it was not.
 *   2. **Two credential tiers.** Partner-level calls (creating firms) use the
 *      platform token; firm-level calls (minting an onboarding token) use that
 *      firm's own. The token is therefore a per-call argument, not instance state.
 *
 * No stub counterpart. Unlike e-signature there is nothing useful a fake Confido
 * can do for onboarding, and a firm that appears connected but is not would be
 * worse than an honest "not configured" — the same posture StubPaymentProvider
 * takes toward money.
 */

const DEFAULT_API_URL = "https://api.sandbox.gravity-legal.com/v2";

/** An admin is waiting on these inside an HTTP request; do not hang the tab. */
const REQUEST_TIMEOUT_MS = 15_000;

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

export class ConfidoClient {
  constructor(
    private readonly partnerToken: string,
    private readonly webhookSecret: string,
    private readonly apiUrl: string = DEFAULT_API_URL,
  ) {}

  // ─── Partner-level ─────────────────────────────────────────────────────────

  /**
   * Create a Firm.
   *
   * **Never retry this call.** Confido offers no idempotency key and the
   * mutation is not idempotent, so a retry after a timeout that actually
   * succeeded creates a second firm we have no record of and no API to delete.
   * Retry/backoff belongs on reads only.
   */
  async createFirm(input: {
    name: string;
    mockOnboarding?: boolean;
  }): Promise<ConfidoCreateFirmResult> {
    const data = await this.gql<{ createFirm: ConfidoCreateFirmResult }>(
      this.partnerToken,
      `mutation CreateFirm($input: CreateFirmInput) {
        createFirm(input: $input) {
          id
          status
          apiToken
          bankAccounts { id category isDefault nickname }
        }
      }`,
      { input },
    );
    return data.createFirm;
  }

  /**
   * The firm's current status.
   *
   * Mandatory after `createFirm`, and after every `firm.updated` webhook: the
   * mutation's own payload is stale, and the webhook carries only an id. Both
   * paths must ask rather than assume — which also makes out-of-order webhook
   * delivery converge on the truth instead of writing a stale status.
   */
  async getFirm(firmToken: string): Promise<ConfidoFirmSnapshot> {
    const data = await this.gql<{ firm: ConfidoFirmSnapshot }>(
      firmToken,
      `query GetFirm { firm { id status isAcceptingPayments } }`,
    );
    return data.firm;
  }

  async listBankAccounts(firmToken: string): Promise<ConfidoBankAccount[]> {
    const data = await this.gql<{
      bankAccountsList: { bankAccounts: ConfidoBankAccount[] };
    }>(
      firmToken,
      `query BankAccounts {
        bankAccountsList { bankAccounts { id category isDefault nickname } }
      }`,
    );
    return data.bankAccountsList.bankAccounts;
  }

  /** Brands the Confido-hosted payment page so it carries the firm's identity. */
  async updateBranding(
    firmId: string,
    input: ConfidoBrandingInput,
  ): Promise<void> {
    await this.gql(
      this.partnerToken,
      `mutation Branding($firmId: String, $input: FirmBrandingUpdateInput!) {
        firmBrandingUpdate(firmId: $firmId, input: $input) { headerName }
      }`,
      { firmId, input },
    );
  }

  /**
   * Give someone at the firm a Confido login.
   *
   * Embedded onboarding creates a Firm but no user, and several things are
   * portal-only: revoking the API token, monthly statements, the branding page.
   * Without this the firm cannot reach any of them and each becomes a support
   * request.
   *
   * Non-fatal at the call site — a firm that exists without a portal login is
   * recoverable; a firm creation aborted because an invite email bounced is not.
   */
  async inviteUser(
    firmId: string,
    input: { email: string; firstName: string; lastName: string; role: string },
  ): Promise<void> {
    await this.gql(
      this.partnerToken,
      `mutation InviteUser($input: InviteUserInput!) {
        inviteUser(input: $input) { id }
      }`,
      { input: { ...input, firmId } },
    );
  }

  /** Connect: trade an authorization code for a firm token we then store. */
  async exchangeCodeForFirmToken(
    code: string,
    nickname: string,
  ): Promise<ConfidoExchangeCodeResult> {
    const data = await this.gql<{
      firmApiTokenExchangeCode: ConfidoExchangeCodeResult;
    }>(
      this.partnerToken,
      `mutation Exchange($input: FirmApiTokenExchangeCodeInput!) {
        firmApiTokenExchangeCode(input: $input) { apiToken firmId }
      }`,
      { input: { code, nickname } },
    );
    return data.firmApiTokenExchangeCode;
  }

  // ─── Firm-level ────────────────────────────────────────────────────────────

  /**
   * A short-lived, frontend-safe token for onboarding.js.
   *
   * Valid 24 hours, and never persisted: it is public-prefixed and disposable,
   * so storing it would add an exfiltration surface for no benefit. Mint a fresh
   * one whenever the settings page opens.
   */
  async createOnboardingToken(
    firmToken: string,
  ): Promise<ConfidoOnboardingToken> {
    const data = await this.gql<{
      createOnboardingToken: ConfidoOnboardingToken;
    }>(
      firmToken,
      `mutation CreateOnboardingToken {
        createOnboardingToken { token expiresAt }
      }`,
    );
    return data.createOnboardingToken;
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Verify a delivery against the shared webhook secret.
   *
   * HMAC-SHA512, base64, over the **raw bytes**. Confido's own sample HMACs a
   * re-serialised parse of the body, which will not reliably reproduce what they
   * signed — key order and whitespace both differ. Compared in constant time,
   * as the Dropbox Sign provider does.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    const expected = createHmac("sha512", this.webhookSecret)
      .update(rawBody)
      .digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature ?? "");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ─── Transport ─────────────────────────────────────────────────────────────

  private async gql<T>(
    token: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.apiUrl, {
        method: "POST",
        headers: {
          "x-api-key": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Never interpolate the token into a message — these reach logs.
      throw new ExternalServiceError(
        `Confido request failed: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ExternalServiceError(
        `Confido API error (${res.status}): ${body.slice(0, 300)}`,
      );
    }

    const payload = (await res.json().catch(() => null)) as GqlResponse<T> | null;

    if (!payload) {
      throw new ExternalServiceError("Confido returned an unreadable response");
    }

    // The GraphQL trap: a 200 whose body carries the failure.
    if (payload.errors?.length) {
      const message = payload.errors.map((e) => e.message).join("; ");
      throw new ExternalServiceError(
        `Confido API error: ${message.slice(0, 300)}`,
      );
    }

    if (!payload.data) {
      throw new ExternalServiceError("Confido returned no data");
    }

    return payload.data;
  }
}

let cached: ConfidoClient | null = null;

/**
 * The configured client. Throws when Confido is not configured, rather than
 * returning a stub — callers should be asking `isConfidoConfigured()` first and
 * refusing, not proceeding against a fake.
 */
export const getConfidoClient = (): ConfidoClient => {
  if (cached) return cached;
  const { CONFIDO_PARTNER_TOKEN, CONFIDO_WEBHOOK_SECRET, CONFIDO_API_URL } = env;
  if (!CONFIDO_PARTNER_TOKEN || !CONFIDO_WEBHOOK_SECRET) {
    throw new ExternalServiceError("Confido is not configured");
  }
  cached = new ConfidoClient(
    CONFIDO_PARTNER_TOKEN,
    CONFIDO_WEBHOOK_SECRET,
    CONFIDO_API_URL ?? DEFAULT_API_URL,
  );
  return cached;
};

/**
 * True when both halves of the platform credential are present.
 *
 * Both, because a partner token without a webhook secret leaves a public
 * endpoint unable to verify what it is sent while the rest of the system
 * believes the integration is live.
 */
export const isConfidoConfigured = (): boolean =>
  Boolean(env.CONFIDO_PARTNER_TOKEN && env.CONFIDO_WEBHOOK_SECRET);

/** Test seam: drops the memoized client so a config change is picked up. */
export const resetConfidoClient = (): void => {
  cached = null;
};
