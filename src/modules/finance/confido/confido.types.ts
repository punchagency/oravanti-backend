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

export interface ConfidoBrandingInput {
  headerName?: string;
  headerImg?: { url: string };
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
