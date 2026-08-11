import { env } from "../../config/env";

/**
 * Contract for taking money for an invoice.
 *
 * Modelled on `ESignatureProvider`, which is this repo's one worked example of
 * a swappable external service — same interface-plus-stub-plus-cached-factory
 * shape, so the two read alike.
 *
 * Nothing implements this against a real provider yet. The seam exists now
 * because the parts that are painful to retrofit are the parts that touch the
 * ledger: idempotency on recorded payments, and an event store. Adding those to
 * a live `invoice_payments` later means a migration over real money.
 */

export interface CheckoutInput {
  invoiceId: string;
  organizationId: string;
  invoiceNumber: string;
  /** Minor units, to avoid handing a float to a payment API. */
  amountCents: number;
  currency: string;
  description: string;
  payerEmail: string | null;
  /** Where the provider returns the payer once they are done. */
  returnUrl: string;
}

export interface CheckoutSession {
  /** Where to send the payer. */
  url: string;
  /** The provider's id for this attempt, for correlating the webhook back. */
  reference: string;
}

/** A payment the provider says succeeded. */
export interface PaymentEvent {
  /** The provider's event id — the idempotency key for the event store. */
  eventId: string;
  /** The provider's payment id — the idempotency key for the ledger row. */
  reference: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
}

export interface PaymentProvider {
  readonly name: string;
  createCheckoutSession(input: CheckoutInput): Promise<CheckoutSession>;
  /**
   * Verify a webhook came from the provider.
   *
   * Takes the RAW body, not a parsed object: every provider signs the exact
   * bytes, and re-serialising a parsed body will not reproduce them.
   */
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
  /** Extract a completed payment, or null for events we do not act on. */
  parseEvent(rawBody: Buffer): PaymentEvent | null;
}

/**
 * The fallback when no provider is configured, which is every environment
 * today.
 *
 * It returns a URL to our own demo page and **records nothing**. That is the
 * whole point: the lead-facing pay button has always been a dummy, and now that
 * invoices are real, a stub that "succeeded" would write payments to
 * `invoice_payments` that never happened — turning a UI that overstates itself
 * into accounts that do. An unpaid invoice that is genuinely unpaid is the
 * honest state.
 */
export class StubPaymentProvider implements PaymentProvider {
  readonly name = "stub";

  async createCheckoutSession(input: CheckoutInput): Promise<CheckoutSession> {
    return {
      url: `${input.returnUrl}?demo=1`,
      reference: `stub_${input.invoiceId}`,
    };
  }

  /**
   * False, always. The stub cannot verify anything, and returning true would
   * make an unauthenticated public endpoint accept any payload claiming a
   * payment — which is a far worse failure than the endpoint being unusable.
   * (The e-signature stub returns true; it is gated behind a signature request
   * that only the firm can create, and it moves no money.)
   */
  verifyWebhook(): boolean {
    return false;
  }

  parseEvent(): PaymentEvent | null {
    return null;
  }
}

const stubProvider = new StubPaymentProvider();

let cached: PaymentProvider | null = null;

/**
 * The configured provider, or the stub. Import from here rather than
 * constructing directly, so the fallback is consistent across the module.
 */
export const getPaymentProvider = (): PaymentProvider => {
  if (cached) return cached;
  // When a Stripe implementation lands it slots in here, exactly as
  // DropboxSignProvider does in getESignatureProvider.
  cached = stubProvider;
  return cached;
};

/**
 * True when a real provider is configured.
 *
 * Every path that could take money checks this and refuses rather than
 * pretending. The public payment page uses it to say "demo" out loud.
 */
export const isPaymentProviderConfigured = (): boolean =>
  Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
