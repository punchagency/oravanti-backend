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
import {
  getConfidoClient,
  isConfidoConfigured,
} from "../../finance/confido/confido.client";
import type { ConfidoBankAccount } from "../../finance/confido/confido.types";
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
      .select({ name: organization.name, displayName: organization.displayName })
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

    await applyBranding(organizationId, created.id, org.displayName || org.name);
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

/**
 * Brand the Confido-hosted payment page.
 *
 * Non-fatal: a failure here must never abort firm creation, which is the one
 * step in this flow that cannot be safely repeated.
 *
 * `headerImg` is deliberately omitted. `organization.logo` holds an R2 object
 * key that we sign on demand, and a signed URL expires — handing one to Confido
 * would leave the payment page's logo broken weeks later, silently. A stable
 * public URL is a follow-up.
 */
const applyBranding = async (
  organizationId: string,
  confidoFirmId: string,
  headerName: string,
): Promise<void> => {
  try {
    await getConfidoClient().updateBranding(confidoFirmId, { headerName });
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
      defaults = pickDefaults(await client.listBankAccounts(firmToken));
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
