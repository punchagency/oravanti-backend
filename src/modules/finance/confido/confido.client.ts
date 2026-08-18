import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../../config/env";
import { ExternalServiceError } from "../../../utils/error/app-error";
import type {
  ConfidoBankAccount,
  ConfidoPayer,
  ConfidoPaymentLink,
  ConfidoStatementRecord,
  ConfidoTransaction,
  ConfidoBrandingImageUpload,
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

/** Selected wherever a PaymentLink comes back, so the shapes cannot drift. */
const LINK_FIELDS = `
  id
  url
  status
  externalId
  amounts { amount bankAccount { id category } }
`;

const DEFAULT_API_URL = "https://api.sandbox.gravity-legal.com/v2";

/** An admin is waiting on these inside an HTTP request; do not hang the tab. */
const REQUEST_TIMEOUT_MS = 15_000;

interface GqlError {
  message: string;
  code?: string;
  status?: number;
  extensions?: { code?: string };
}

interface GqlResponse<T> {
  data?: T;
  errors?: GqlError[];
}

/**
 * A GraphQL-level failure, carrying Confido's own classification.
 *
 * Callers need to tell "this record does not exist" from "Confido is having a
 * bad day", and the difference matters: a lookup-then-create flow that treats
 * every failure as absence will happily create a duplicate every time the API
 * is briefly down. Confido has no delete endpoint, so duplicates are permanent.
 *
 * Their reporting is not consistent enough to classify by status alone —
 * a missing Client is a 400 `USER_INPUT_ERROR`, while a missing PaymentLink is
 * a 500 `INTERNAL_SERVER_ERROR` reading "Paylink not found" — so the codes,
 * statuses and messages are all preserved and each call site decides.
 */
export class ConfidoApiError extends ExternalServiceError {
  constructor(
    message: string,
    readonly codes: string[] = [],
    readonly statuses: number[] = [],
    readonly messages: string[] = [],
  ) {
    super(message);
  }

  /** True when Confido is reporting absence rather than failure. */
  isNotFound(...messageFragments: string[]): boolean {
    if (this.codes.includes("USER_INPUT_ERROR")) return true;
    return messageFragments.some((f) =>
      this.messages.some((m) => m.toLowerCase().includes(f.toLowerCase())),
    );
  }
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
          bankAccounts { id category isDefault nickname isFeeAccount }
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
        bankAccountsList { bankAccounts { id category isDefault nickname isFeeAccount } }
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
        firmBrandingUpdate(firmId: $firmId, input: $input) { headerName headerImg }
      }`,
      { firmId, input },
    );
  }

  /**
   * Reserve a slot for a header image.
   *
   * `headerImg` is not a URL — Confido ingests the bytes into their own storage
   * and the branding mutation then refers to them by `s3Key`. So a logo is a
   * three-step affair: reserve, PUT, then reference. That is also why there is no
   * expiring-URL problem to design around: nothing of ours is hot-linked.
   */
  async createBrandingImageUpload(
    firmId: string,
    filename: string,
    contentType: string,
  ): Promise<ConfidoBrandingImageUpload> {
    const data = await this.gql<{
      firmBrandingHeaderImgUploadUrl: ConfidoBrandingImageUpload;
    }>(
      this.partnerToken,
      `query BrandingUpload($firmId: String, $filename: String!, $contentType: String!) {
        firmBrandingHeaderImgUploadUrl(
          firmId: $firmId, filename: $filename, contentType: $contentType
        ) { s3Key uploadUrl }
      }`,
      { firmId, filename, contentType },
    );
    return data.firmBrandingHeaderImgUploadUrl;
  }

  /**
   * PUT the bytes at the reserved slot.
   *
   * Not a GraphQL call — `uploadUrl` is a presigned storage URL, so it takes the
   * raw body and none of our headers. Sending `x-api-key` here would break the
   * signature.
   */
  async uploadBrandingImage(
    uploadUrl: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ExternalServiceError(
        `Confido image upload failed: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new ExternalServiceError(
        `Confido image upload failed (${res.status})`,
      );
    }
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

  /**
   * Point the firm's fee debits at a specific bank account.
   *
   * Confido does not net its fee out of a deposit — a $500 trust payment puts
   * the full $500 in trust — and instead accumulates fees and debits them
   * monthly from whichever account carries `isFeeAccount`. That separation is
   * what keeps a trust deposit whole, and it only works if the fee account is
   * the OPERATING one. Left unset, it is whatever Confido defaulted to.
   */
  async updateFirmAccounts(
    firmToken: string,
    input: {
      feeBankAccountId?: string;
      defaultOperatingId?: string;
      defaultTrustId?: string;
    },
  ): Promise<void> {
    // Firm-level, unlike its neighbours: `FirmUpdateInput` has no `firmId`
    // field, so the token identifies the firm. `paymentSettingsUpdate` takes one
    // and `firmBrandingUpdate` takes one — this does not, and passing it would
    // be rejected as an unknown field.
    await this.gql(
      firmToken,
      `mutation FirmUpdate($input: FirmUpdateInput!) {
        firmUpdate(input: $input) { id }
      }`,
      { input },
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

  /**
   * Find the Confido Client standing for one of our leads or clients.
   *
   * Keyed on `externalId` — our own uuid — so no mapping table is needed and
   * the relationship survives `openCase` repointing an invoice from a lead to
   * the client it became.
   *
   * Returns null when absent rather than throwing, but ONLY for a genuine
   * absence: Confido reports a missing Client as a 400 `USER_INPUT_ERROR`, and
   * anything else propagates. Treating every failure as absence would create a
   * duplicate Client each time the API hiccuped, and there is no delete
   * endpoint to undo that.
   */
  async findClientByExternalId(
    firmToken: string,
    externalId: string,
  ): Promise<ConfidoPayer | null> {
    try {
      const data = await this.gql<{ client: ConfidoPayer | null }>(
        firmToken,
        `query FindClient($externalId: String) {
          client(externalId: $externalId) { id externalId }
        }`,
        { externalId },
      );
      return data.client ?? null;
    } catch (err) {
      if (err instanceof ConfidoApiError && err.isNotFound("could not find")) {
        return null;
      }
      throw err;
    }
  }

  async createClient(
    firmToken: string,
    input: {
      firmId: string;
      clientName: string;
      externalId: string;
      email?: string;
    },
  ): Promise<ConfidoPayer> {
    const data = await this.gql<{ addClient: ConfidoPayer }>(
      firmToken,
      `mutation AddClient($input: AddClientInput!) {
        addClient(input: $input) { id externalId }
      }`,
      { input },
    );
    return data.addClient;
  }

  /**
   * Find the payment link for one of our invoices, by `externalId`.
   *
   * Same absence-vs-failure care as `findClientByExternalId`, but Confido is
   * less helpful here: a missing link comes back as a **500
   * `INTERNAL_SERVER_ERROR`** reading "Paylink not found", not a 400. So this
   * has to match on the message, which is fragile — if Confido ever reworded
   * it, this would start reporting real outages as absence and mint duplicate
   * links. Worth a periodic check against the sandbox.
   */
  async findPaymentLinkByExternalId(
    firmToken: string,
    externalId: string,
  ): Promise<ConfidoPaymentLink | null> {
    try {
      const data = await this.gql<{ paymentLink: ConfidoPaymentLink | null }>(
        firmToken,
        `query FindLink($externalId: String) {
          paymentLink(externalId: $externalId) { ${LINK_FIELDS} }
        }`,
        { externalId },
      );
      return data.paymentLink ?? null;
    } catch (err) {
      if (err instanceof ConfidoApiError && err.isNotFound("paylink not found")) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Create a payment link.
   *
   * **Never retry**, for the same reason as `createFirm`: there is no
   * idempotency key and no delete endpoint, so a retry after a timeout that
   * actually succeeded leaves a second link against the same invoice. Recovery
   * is `findPaymentLinkByExternalId`, not another create.
   */
  async addPaymentLink(
    firmToken: string,
    input: {
      clientId: string;
      externalId: string;
      trust?: number;
      operating?: number;
      memo?: string;
      partialPaymentAllowed?: boolean;
      sendReceipts?: boolean;
    },
  ): Promise<ConfidoPaymentLink> {
    const data = await this.gql<{ addPaymentLink: ConfidoPaymentLink }>(
      firmToken,
      `mutation AddLink($input: AddPaymentLinkInput!) {
        addPaymentLink(input: $input) { ${LINK_FIELDS} }
      }`,
      { input },
    );
    return data.addPaymentLink;
  }

  /** One transaction, for turning a thin webhook into a ledger row. */
  async getTransaction(
    firmToken: string,
    id: string,
  ): Promise<ConfidoTransaction> {
    const data = await this.gql<{ transaction: ConfidoTransaction }>(
      firmToken,
      `query GetTransaction($id: String!) {
        transaction(id: $id) {
          id type status_v2 amountProcessed surchargeAmount
          bankAccount { id category }
          paymentLink { id externalId }
          payment { id }
        }
      }`,
      { id },
    );
    return data.transaction;
  }

  /**
   * Recent statements.
   *
   * There is no `statement(id:)` query, so a webhook carrying only a statement
   * id has to fetch a window and match within it. `limit` is required by their
   * schema. A statement older than the window is unreachable this way, which is
   * why ingestion also runs on a lookback rather than webhooks alone.
   */
  async listStatements(
    firmToken: string,
    limit = 12,
  ): Promise<ConfidoStatementRecord[]> {
    const data = await this.gql<{
      statements: { records: ConfidoStatementRecord[] };
    }>(
      firmToken,
      `query Statements($limit: Int!) {
        statements(limit: $limit, orderDir: desc) {
          records {
            id
            month
            bankAccounts {
              bankAccountCategory bankAccountMask bankAccountNickname
              totalPaymentVolume totalFees cardFees achFees surchargeFeesCollected
            }
            debits { amount fromBankAccountCategory fromBankAccountMask statementDescriptor }
            additionalFees { amount description type }
            additionalCredits { amount description type }
          }
        }
      }`,
      { limit },
    );
    return data.statements.records;
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
      const messages = payload.errors.map((e) => e.message);
      throw new ConfidoApiError(
        `Confido API error: ${messages.join("; ").slice(0, 300)}`,
        payload.errors
          .map((e) => e.extensions?.code ?? e.code)
          .filter((c): c is string => Boolean(c)),
        payload.errors
          .map((e) => e.status)
          .filter((n): n is number => typeof n === "number"),
        messages,
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
