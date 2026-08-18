/**
 * The slice of Confido's GraphQL schema we depend on.
 *
 * Hand-written rather than generated: we use a dozen fields out of 276 types,
 * and the shapes below are the ones the sandbox actually returned during the
 * spike (see confido_legal_integration.md and scripts/checks/14-confido-sandbox.ts).
 */

/** A firm's bank account. `category` is an untyped String on their side. */
export interface ConfidoBankAccount {
  id: string;
  category: string;
  isDefault: boolean;
  nickname: string;
  /** True on the one account Confido debits monthly fees from. */
  isFeeAccount: boolean;
}

export interface ConfidoFirmSnapshot {
  id: string;
  status: string;
  isAcceptingPayments: boolean;
}

export interface ConfidoCreateFirmResult {
  id: string;
  /** The firm's own long-lived API token. Encrypted before it touches the DB. */
  apiToken: string;
  bankAccounts: ConfidoBankAccount[];
  /**
   * Present but deliberately unused for persistence: `createFirm` returns a
   * snapshot written before activation lands, so it can say CREATED for a firm
   * that is already ACTIVE. Always re-query before storing status.
   */
  status: string;
}

export interface ConfidoOnboardingToken {
  token: string;
  expiresAt: string;
}

/**
 * Reserved slot for a header image.
 *
 * Confido ingests the bytes rather than hot-linking ours, so a logo is
 * reserve -> PUT -> reference by key.
 */
export interface ConfidoBrandingImageUpload {
  s3Key: string;
  uploadUrl: string;
}

export interface ConfidoBrandingInput {
  headerName?: string;
  /** Refers to bytes already uploaded via `createBrandingImageUpload`. */
  headerImg?: { s3Key: string; filename: string; contentType: string };
  backgroundColor?: string;
  centerColor?: string;
  footerText?: string;
}

export interface ConfidoExchangeCodeResult {
  apiToken: string;
  firmId: string;
}

/** The envelope every Confido webhook delivery uses. Bodies arrive as an array of these. */
export interface ConfidoWebhookEvent {
  type: string;
  firmId: string;
  eventId: string;
  data?: Record<string, unknown>;
}

/**
 * A payer, keyed on our own uuid via `externalId`.
 *
 * Named "payer" rather than "client" because `ConfidoClient` is the API client
 * class — Confido calls this a Client, we call the thing that talks to them one.
 */
export interface ConfidoPayer {
  id: string;
  externalId: string | null;
}

export interface ConfidoAmountLeg {
  amount: number;
  bankAccount: { id: string; category: string };
}

export interface ConfidoPaymentLink {
  id: string;
  url: string;
  status: string;
  externalId: string | null;
  amounts: ConfidoAmountLeg[];
}

/** A single movement of money. One per bank account Confido credits. */
export interface ConfidoTransaction {
  id: string;
  type: string;
  status_v2: string;
  /** Cents, and deliberately EXCLUSIVE of any surcharge. */
  amountProcessed: number;
  surchargeAmount: number;
  bankAccount: { id: string; category: string };
  paymentLink: { id: string; externalId: string | null } | null;
  payment: { id: string } | null;
}

/**
 * A monthly statement.
 *
 * Every amount below is in CENTS, including the ones Confido types as `Float!`
 * and the one it types as `Int!` — the inconsistency is cosmetic. Confirmed
 * against a sandbox statement where `cardFees + achFees == totalFees` and an
 * "unauthorized ACH return" fee came through as 2500, which is $25 rather than
 * $2,500.
 *
 * Note there are no summary fields: payment volume, total fees and net fees are
 * the firm-facing figures from Confido's own statement UI, and have to be
 * derived by folding `bankAccounts`.
 */
export interface ConfidoStatementBankAccount {
  bankAccountCategory: string;
  bankAccountMask: string;
  bankAccountNickname: string;
  totalPaymentVolume: number;
  totalFees: number;
  cardFees: number;
  achFees: number;
  surchargeFeesCollected: number;
}

export interface ConfidoStatementDebitRow {
  amount: number;
  fromBankAccountCategory: string;
  fromBankAccountMask: string;
  statementDescriptor: string;
}

export interface ConfidoStatementRecord {
  id: string;
  month: string;
  bankAccounts: ConfidoStatementBankAccount[];
  debits: ConfidoStatementDebitRow[];
  additionalFees: { amount: number; description: string; type: string }[];
  additionalCredits: { amount: number; description: string; type: string }[];
}
