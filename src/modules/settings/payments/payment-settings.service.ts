import { and, eq, sql } from "drizzle-orm";
import { env } from "../../../config/env";
import { db, systemDb } from "../../../db/client";
import { organization } from "../../../db/schema/auth-schema";
import { confidoFirms } from "../../../db/schema/confido-firms";
import { staff } from "../../../db/schema/staff";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../utils/error/app-error";
import {
  decryptPaymentValue,
  encryptPaymentValue,
  PaymentDecryptionError,
} from "../../../utils/payment-crypto";
import { storageService } from "../../../utils/storage/storage.service";
import {
  getConfidoClient,
  isConfidoConfigured,
} from "../../finance/confido/confido.client";
import type {
  ConfidoBankAccount,
  ConfidoBrandingInput,
} from "../../finance/confido/confido.types";
import {
  canAcceptPayments,
  normalizeFirmStatus,
  stateForStatus,
  type PaymentAccountState,
} from "../../finance/confido/firm-status";

/**
 * The firm's payment-processor setup.
 *
 * Slice 1 of the Confido integration: this connects a firm and tracks its
 * underwriting, and takes no money. Nothing here should imply that it can.
 */

const DEFAULT_ONBOARDING_JS_URL =
  "https://js.sandbox.gravity-legal.com/onboarding.js";

/** What the settings tab renders from. Deliberately omits the token. */
export interface PaymentAccountView {
  /** False when the platform has no Confido credentials at all. */
  configured: boolean;
  state: PaymentAccountState;
  status: string | null;
  isAcceptingPayments: boolean;
  /** Last 6 characters only — enough to quote to support, useless to anyone else. */
  confidoFirmIdMasked: string | null;
  onboardingMethod: string | null;
  bankAccounts: { trust: string | null; operating: string | null };
  brandingAppliedAt: Date | null;
  statusCheckedAt: Date | null;
}

export interface OnboardingSession {
  scriptUrl: string;
  token: string;
  expiresAt: string;
  /** Keeps the >25%-owner step on our domain instead of Confido's. */
  ownerInviteUrl: string;
  state: PaymentAccountState;
}

const maskFirmId = (id: string | null): string | null =>
  id ? `…${id.slice(-6)}` : null;

/**
 * Columns projected explicitly, never `select()`.
 *
 * A bare select returns `encrypted_api_token`, and RLS would happily hand it to
 * the owning org's own frontend — RLS answers "whose row is this", not "which
 * columns may leave the building".
 */
const ACCOUNT_COLUMNS = {
  id: confidoFirms.id,
  organizationId: confidoFirms.organizationId,
  confidoFirmId: confidoFirms.confidoFirmId,
  status: confidoFirms.status,
  isAcceptingPayments: confidoFirms.isAcceptingPayments,
  onboardingMethod: confidoFirms.onboardingMethod,
  provisioningState: confidoFirms.provisioningState,
  defaultTrustBankAccountId: confidoFirms.defaultTrustBankAccountId,
  defaultOperatingBankAccountId: confidoFirms.defaultOperatingBankAccountId,
  brandingAppliedAt: confidoFirms.brandingAppliedAt,
  statusCheckedAt: confidoFirms.statusCheckedAt,
} as const;

const toView = (
  row: typeof ACCOUNT_COLUMNS extends never ? never : Record<string, unknown>,
): PaymentAccountView => {
  const status = (row.status as string) ?? null;
  const provisioning = row.provisioningState as string;
  return {
    configured: true,
    state:
      provisioning === "creating"
        ? "provisioning"
        : stateForStatus(status ?? ""),
    status,
    isAcceptingPayments: Boolean(row.isAcceptingPayments),
    confidoFirmIdMasked: maskFirmId((row.confidoFirmId as string) ?? null),
    onboardingMethod: (row.onboardingMethod as string) ?? null,
    bankAccounts: {
      trust: (row.defaultTrustBankAccountId as string) ?? null,
      operating: (row.defaultOperatingBankAccountId as string) ?? null,
    },
    brandingAppliedAt: (row.brandingAppliedAt as Date) ?? null,
    statusCheckedAt: (row.statusCheckedAt as Date) ?? null,
  };
};

const NOT_CONFIGURED: PaymentAccountView = {
  configured: false,
  state: "not_configured",
  status: null,
  isAcceptingPayments: false,
  confidoFirmIdMasked: null,
  onboardingMethod: null,
  bankAccounts: { trust: null, operating: null },
  brandingAppliedAt: null,
  statusCheckedAt: null,
};

const NOT_STARTED: PaymentAccountView = {
  ...NOT_CONFIGURED,
  configured: true,
  state: "not_started",
};

const readAccount = async (organizationId: string) => {
  const [row] = await db
    .select(ACCOUNT_COLUMNS)
    .from(confidoFirms)
    .where(eq(confidoFirms.organizationId, organizationId))
    .limit(1);
  return row ?? null;
};

/** Reads and decrypts the firm token, or explains why it cannot. */
const firmTokenFor = async (organizationId: string): Promise<string> => {
  const [row] = await db
    .select({ token: confidoFirms.encryptedApiToken })
    .from(confidoFirms)
    .where(eq(confidoFirms.organizationId, organizationId))
    .limit(1);

  if (!row?.token) {
    throw new BadRequestError("This firm has no Confido credential yet");
  }
  return decryptPaymentValue(row.token);
};

const pickDefaults = (accounts: ConfidoBankAccount[]) => ({
  trust:
    accounts.find((a) => a.category === "trust" && a.isDefault)?.id ?? null,
  operating:
    accounts.find((a) => a.category === "operating" && a.isDefault)?.id ?? null,
});

// ─── Reads ───────────────────────────────────────────────────────────────────

export const getPaymentAccount = async (
  organizationId: string,
): Promise<PaymentAccountView> => {
  if (!isConfidoConfigured()) return NOT_CONFIGURED;

  const row = await readAccount(organizationId);
  if (!row) return NOT_STARTED;

  return toView(row as unknown as Record<string, unknown>);
};

// ─── Onboarding ──────────────────────────────────────────────────────────────

/**
 * Get (or lazily create) the firm, then mint a fresh onboarding token.
 *
 * Idempotent by design, because it is also the 24-hour token refresh: the
 * frontend calls it again when onboarding.js reports its token expiring, and a
 * second call must not produce a second firm.
 *
 * The ordering matters and is not arbitrary:
 *
 *   1. Claim the organization with a placeholder row. The unique index does the
 *      locking, so two admins opening the tab at once cannot both proceed —
 *      `createFirm` has no idempotency key and Confido has no delete API, so a
 *      duplicate is permanent.
 *   2. Only then call `createFirm`. If it throws, the placeholder is removed so
 *      a retry is possible.
 *   3. Re-query the firm rather than trusting `createFirm`'s own payload, which
 *      is written before activation lands and can say CREATED for a firm that is
 *      already ACTIVE.
 *   4. Branding and the portal invite are non-fatal. A firm without branding is
 *      cosmetic; a firm creation aborted after the remote firm already exists is
 *      an orphan.
 */
export const startOnboardingSession = async (
  organizationId: string,
  actorStaffId: string | null,
): Promise<OnboardingSession> => {
  if (!isConfidoConfigured()) {
    throw new BadRequestError("Payments are not configured on this deployment");
  }

  const client = getConfidoClient();
  const existing = await readAccount(organizationId);

  if (existing?.provisioningState === "creating" && existing.confidoFirmId) {
    // A previous attempt got as far as creating the firm but not finishing.
    // Recoverable, so fall through and finish it rather than blocking forever.
  } else if (existing?.provisioningState === "creating") {
    throw new ConflictError(
      "Payment setup is already in progress. Refresh in a moment.",
    );
  }

  if (!existing) {
    // Claim first, call Confido second.
    const claimed = await db
      .insert(confidoFirms)
      .values({ organizationId, provisioningState: "creating" })
      .onConflictDoNothing({ target: confidoFirms.organizationId })
      .returning({ id: confidoFirms.id });

    if (claimed.length === 0) {
      throw new ConflictError(
        "Payment setup is already in progress. Refresh in a moment.",
      );
    }

    const [org] = await db
      .select({
        name: organization.name,
        displayName: organization.displayName,
        logo: organization.logo,
      })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);

    if (!org) throw new NotFoundError("Organization not found");

    let created;
    try {
      created = await client.createFirm({
        name: org.displayName || org.name,
      });
    } catch (err) {
      // Remove the claim so the admin can try again. If the call actually
      // succeeded on Confido's side we have just orphaned a firm — unavoidable
      // without an idempotency key, and the reason this is never auto-retried.
      await db
        .delete(confidoFirms)
        .where(
          and(
            eq(confidoFirms.organizationId, organizationId),
            eq(confidoFirms.provisioningState, "creating"),
          ),
        );
      throw err;
    }

    const defaults = pickDefaults(created.bankAccounts ?? []);

    await db
      .update(confidoFirms)
      .set({
        confidoFirmId: created.id,
        encryptedApiToken: encryptPaymentValue(created.apiToken),
        onboardingMethod: "embedded",
        defaultTrustBankAccountId: defaults.trust,
        defaultOperatingBankAccountId: defaults.operating,
        updatedAt: new Date(),
      })
      .where(eq(confidoFirms.organizationId, organizationId));

    await applyBranding(
      organizationId,
      created.id,
      org.displayName || org.name,
      org.logo ?? null,
    );
    await inviteFirmAdmin(organizationId, created.id, actorStaffId);
  }

  // Whether the row is new or was already here, the remote status is the truth.
  await refreshStatus(organizationId);

  const firmToken = await firmTokenFor(organizationId);
  const token = await client.createOnboardingToken(firmToken);

  const view = await getPaymentAccount(organizationId);

  return {
    scriptUrl: env.CONFIDO_ONBOARDING_JS_URL ?? DEFAULT_ONBOARDING_JS_URL,
    token: token.token,
    expiresAt: token.expiresAt,
    ownerInviteUrl: `${env.FRONTEND_APP_URL}/payments/owner-form`,
    state: view.state,
  };
};

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** Confido stores the bytes, so it needs a type — and R2 does not hand one back. */
const contentTypeFor = (key: string): string | null => {
  const ext = key.split(".").pop()?.toLowerCase();
  return ext ? (IMAGE_CONTENT_TYPES[ext] ?? null) : null;
};

/**
 * Fetch the firm's logo, wherever it lives.
 *
 * `organization.logo` is normally an R2 object key, but `firm-profile.service`
 * documents that legacy rows hold an absolute URL, and both still exist.
 */
const readLogo = async (
  logo: string,
): Promise<{ bytes: Buffer; filename: string; contentType: string } | null> => {
  const filename = logo.split("/").pop() || "logo";
  const contentType = contentTypeFor(filename);
  if (!contentType) return null;

  if (/^https?:\/\//.test(logo)) {
    const res = await fetch(logo, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      filename,
      contentType,
    };
  }

  return {
    bytes: await storageService.download(logo),
    filename,
    contentType,
  };
};

/**
 * Brand the Confido-hosted payment page.
 *
 * Since the payer is never redirected back to us, that page is the last thing
 * they see — so it carrying the firm's identity rather than Confido's is worth
 * the extra calls.
 *
 * The logo is a three-step affair because `headerImg` is not a URL: Confido
 * reserves a slot, we PUT the bytes, then the mutation refers to them by key.
 * Nothing of ours is hot-linked, so there is no expiring-URL problem — which is
 * also why the R2 object key works fine as a source despite our own download
 * URLs lasting only an hour.
 *
 * Wholly non-fatal. A failure here must never abort firm creation, which is the
 * one step in this flow that cannot be safely repeated, and a missing logo is
 * cosmetic. The logo is attempted separately from the name and colours so a bad
 * image does not cost the firm its branding entirely.
 */
const applyBranding = async (
  organizationId: string,
  confidoFirmId: string,
  headerName: string,
  logo: string | null,
): Promise<void> => {
  const client = getConfidoClient();
  const input: ConfidoBrandingInput = { headerName };

  if (logo) {
    try {
      const image = await readLogo(logo);
      if (image) {
        const slot = await client.createBrandingImageUpload(
          confidoFirmId,
          image.filename,
          image.contentType,
        );
        await client.uploadBrandingImage(
          slot.uploadUrl,
          image.bytes,
          image.contentType,
        );
        input.headerImg = {
          s3Key: slot.s3Key,
          filename: image.filename,
          contentType: image.contentType,
        };
      }
    } catch (err) {
      // Fall through with name and colours only.
      console.error(
        `[confido] logo upload failed for org ${organizationId}:`,
        (err as Error).message,
      );
    }
  }

  try {
    await client.updateBranding(confidoFirmId, input);
    await db
      .update(confidoFirms)
      .set({ brandingAppliedAt: new Date(), updatedAt: new Date() })
      .where(eq(confidoFirms.organizationId, organizationId));
  } catch (err) {
    console.error(
      `[confido] branding failed for org ${organizationId}:`,
      (err as Error).message,
    );
  }
};

/**
 * Give the admin who set this up a Confido login.
 *
 * Embedded onboarding creates a Firm but no user, and revoking the API token,
 * reading statements and editing branding are all portal-only. Non-fatal for the
 * same reason as branding.
 */
const inviteFirmAdmin = async (
  organizationId: string,
  confidoFirmId: string,
  actorStaffId: string | null,
): Promise<void> => {
  if (!actorStaffId) return;

  try {
    const [member] = await db
      .select({
        email: staff.email,
        firstName: staff.firstName,
        lastName: staff.lastName,
      })
      .from(staff)
      .where(
        and(eq(staff.id, actorStaffId), eq(staff.organizationId, organizationId)),
      )
      .limit(1);

    if (!member?.email) return;

    await getConfidoClient().inviteUser(confidoFirmId, {
      email: member.email,
      firstName: member.firstName ?? "Firm",
      lastName: member.lastName ?? "Admin",
      role: "FIRM_ADMIN",
    });
  } catch (err) {
    console.error(
      `[confido] portal invite failed for org ${organizationId}:`,
      (err as Error).message,
    );
  }
};

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Point the firm's monthly fee debit at its operating account.
 *
 * Confido does not net its fee out of a deposit — a $500 trust payment puts the
 * full $500 in trust — and instead accumulates fees and debits them monthly
 * from whichever account carries `isFeeAccount`. That separation is exactly
 * what keeps a trust deposit whole, and it only holds if the fee account is the
 * operating one.
 *
 * Left alone it is whatever Confido defaulted to, which we have never set and
 * therefore never verified. Setting it explicitly is cheap; the failure mode if
 * it were ever trust is a firm's IOLTA account being debited for card
 * processing, which is the kind of thing that ends in a bar complaint.
 *
 * Non-fatal and idempotent: called on every status refresh, but only acts when
 * the flag is actually on the wrong account.
 */
const ensureFeeAccount = async (
  organizationId: string,
  firmToken: string,
  accounts: ConfidoBankAccount[],
): Promise<void> => {
  const operating = accounts.find(
    (a) => a.category === "operating" && a.isDefault,
  );
  if (!operating) return;

  const feeAccount = accounts.find((a) => a.isFeeAccount);
  if (feeAccount?.id === operating.id) return;

  if (feeAccount && feeAccount.category === "trust") {
    console.error(
      `[confido] org ${organizationId} had its fee account set to a TRUST ` +
        `account (${feeAccount.nickname}); repointing at operating`,
    );
  }

  try {
    await getConfidoClient().updateFirmAccounts(firmToken, {
      feeBankAccountId: operating.id,
    });
  } catch (err) {
    console.error(
      `[confido] could not set the fee account for org ${organizationId}:`,
      (err as Error).message,
    );
  }
};

/**
 * Re-read the firm from Confido and store what it says.
 *
 * Shared by the manual Refresh button and the webhook worker, which is why it
 * takes an organization id and nothing request-shaped. Because it asks rather
 * than trusting a payload, an out-of-order webhook converges on the current
 * truth instead of writing a stale status.
 */
export const refreshStatus = async (
  organizationId: string,
): Promise<PaymentAccountView> => {
  if (!isConfidoConfigured()) return NOT_CONFIGURED;

  const row = await readAccount(organizationId);
  if (!row?.confidoFirmId) return NOT_STARTED;

  const client = getConfidoClient();
  const firmToken = await firmTokenFor(organizationId);
  const snapshot = await client.getFirm(firmToken);

  const status = normalizeFirmStatus(snapshot.status);
  const accepting = Boolean(snapshot.isAcceptingPayments);

  // Bank accounts only exist once underwriting has produced them, so look them
  // up when the firm can trade and we have not cached them yet.
  let defaults = {
    trust: row.defaultTrustBankAccountId,
    operating: row.defaultOperatingBankAccountId,
  };
  if (canAcceptPayments(status, accepting) && !defaults.trust) {
    try {
      const accounts = await client.listBankAccounts(firmToken);
      defaults = pickDefaults(accounts);
      await ensureFeeAccount(organizationId, firmToken, accounts);
    } catch (err) {
      console.error(
        `[confido] bank account lookup failed for org ${organizationId}:`,
        (err as Error).message,
      );
    }
  }

  await db
    .update(confidoFirms)
    .set({
      status,
      isAcceptingPayments: accepting,
      provisioningState: "ready",
      defaultTrustBankAccountId: defaults.trust,
      defaultOperatingBankAccountId: defaults.operating,
      statusCheckedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(confidoFirms.organizationId, organizationId));

  return getPaymentAccount(organizationId);
};

/**
 * A firm's Confido credential, for paths that have no request context.
 *
 * `firmTokenFor` reads through `db`, which is right for the settings routes but
 * wrong here: the public payment page and the webhook worker have no request
 * context, so `db` would fall back to `systemDb` and RLS would not apply while
 * looking as though it did. This reads `systemDb` explicitly with the
 * organization named, which is the same discipline `organizationForConfidoFirm`
 * follows.
 *
 * Returns the firm id alongside the token because creating a payer needs both,
 * and fetching them separately would be two queries for one row.
 */
export const confidoCredentialFor = async (
  organizationId: string,
): Promise<{ credential: string; firmId: string }> => {
  const [row] = await systemDb
    .select({
      token: confidoFirms.encryptedApiToken,
      firmId: confidoFirms.confidoFirmId,
    })
    .from(confidoFirms)
    .where(eq(confidoFirms.organizationId, organizationId))
    .limit(1);

  if (!row?.token || !row.firmId) {
    throw new BadRequestError("This firm has no Confido credential yet");
  }
  return { credential: decryptPaymentValue(row.token), firmId: row.firmId };
};

/**
 * The webhook worker's entry point.
 *
 * Runs with no request context, so `db` would silently fall back to `systemDb`
 * and RLS would not apply. `systemDb` is therefore used explicitly and the
 * organization is resolved from `confido_firm_id` — a wrong mapping here is a
 * cross-tenant write, which is why that column is uniquely indexed.
 */
export const organizationForConfidoFirm = async (
  confidoFirmId: string,
): Promise<string | null> => {
  const [row] = await systemDb
    .select({ organizationId: confidoFirms.organizationId })
    .from(confidoFirms)
    .where(eq(confidoFirms.confidoFirmId, confidoFirmId))
    .limit(1);
  return row?.organizationId ?? null;
};

/** Stamps webhook receipt for observability, independent of what the event said. */
export const markWebhookSeen = async (
  organizationId: string,
): Promise<void> => {
  await systemDb
    .update(confidoFirms)
    .set({ lastWebhookEventAt: new Date() })
    .where(eq(confidoFirms.organizationId, organizationId));
};

// ─── Connect ─────────────────────────────────────────────────────────────────

/**
 * Attach an existing Confido account to this organization.
 *
 * Branding is deliberately NOT applied here: a firm already on Confido may have
 * configured its own, and overwriting it would be presumptuous. It is offered as
 * an explicit action instead.
 */
export const completeConnect = async (
  organizationId: string,
  code: string,
): Promise<PaymentAccountView> => {
  if (!isConfidoConfigured()) {
    throw new BadRequestError("Payments are not configured on this deployment");
  }

  const existing = await readAccount(organizationId);
  if (existing?.confidoFirmId) {
    throw new ConflictError(
      "This firm is already connected to a Confido account",
    );
  }

  const client = getConfidoClient();
  const exchanged = await client.exchangeCodeForFirmToken(code, "Oravanti");

  await db
    .insert(confidoFirms)
    .values({
      organizationId,
      confidoFirmId: exchanged.firmId,
      encryptedApiToken: encryptPaymentValue(exchanged.apiToken),
      onboardingMethod: "connect",
      provisioningState: "ready",
    })
    .onConflictDoUpdate({
      target: confidoFirms.organizationId,
      set: {
        confidoFirmId: exchanged.firmId,
        encryptedApiToken: encryptPaymentValue(exchanged.apiToken),
        onboardingMethod: "connect",
        provisioningState: "ready",
        updatedAt: new Date(),
      },
    });

  return refreshStatus(organizationId);
};

/**
 * Translate a decryption failure into something the UI can act on.
 *
 * The key in force depends on whether an optional env var is set, so a deploy
 * that toggles it makes every stored token unreadable. That is a "reconnect this
 * account" prompt, not a 500.
 */
export const asAccountView = (
  err: unknown,
  fallback: PaymentAccountView,
): PaymentAccountView => {
  if (err instanceof PaymentDecryptionError) {
    return { ...fallback, state: "token_unreadable" };
  }
  throw err;
};

/** Kept for the check script: counts rows without exposing the token column. */
export const countPaymentAccounts = async (): Promise<number> => {
  const [row] = await systemDb
    .select({ count: sql<number>`count(*)::int` })
    .from(confidoFirms);
  return row?.count ?? 0;
};
