import { and, eq } from "drizzle-orm";
import { systemDb } from "../../db/client";
import { invoices } from "../../db/schema/invoices";
import { paymentWebhookEvents } from "../../db/schema/payment-webhook-events";
import { createModuleLogger } from "../../lib/logging/log";
import {
  AuthorizationError,
  BadRequestError,
} from "../../utils/error/app-error";
import { recordPayment } from "./payments.service";
import { getPaymentProvider, isPaymentProviderConfigured } from "./payment.provider";
import { systemAccess } from "./account-access";

const log = createModuleLogger("payment-webhooks.service");

/**
 * Provider webhooks — the path by which money actually reaches the ledger.
 *
 * Public and unauthenticated, so two things are true that are not true anywhere
 * else in this module:
 *
 *   1. **The signature is the only authentication.** A bad signature is a 4xx,
 *      which is also what makes the provider retry — the correct response to
 *      "we could not verify this right now".
 *   2. **There is no request context**, so the `db` proxy falls back to
 *      `systemDb` and RLS does not apply. Every write below therefore carries
 *      an explicit organization predicate, resolved from the invoice the event
 *      names. Reaching for `db` here and assuming tenancy would be a
 *      cross-tenant write waiting to happen.
 */

export type WebhookResult =
  | { handled: false; reason: string }
  | { handled: true; invoiceId: string; duplicate: boolean };

export const handlePaymentWebhook = async (
  rawBody: Buffer,
  signature: string,
): Promise<WebhookResult> => {
  // Nothing is configured, so nothing can be verified. Refusing is the only
  // safe answer: an unauthenticated endpoint that accepts unverified payloads
  // and writes payments is a way to mark any invoice paid from the internet.
  if (!isPaymentProviderConfigured()) {
    log.warn("payment_webhook.processed", { reason: "no provider configured" });
    throw new BadRequestError("No payment provider is configured");
  }

  const provider = getPaymentProvider();
  if (!provider.verifyWebhook(rawBody, signature)) {
    log.warn("payment_webhook.signature_invalid", { reason: "signature verification failed" });
    throw new AuthorizationError("Invalid webhook signature");
  }

  const event = provider.parseEvent(rawBody);
  if (!event) return { handled: false, reason: "Event not actionable" };

  // Claim the event BEFORE doing anything with it. The unique index is what
  // makes a redelivery a constraint violation rather than a second payment,
  // and claiming first means a crash mid-handle leaves a row with a null
  // `processedAt` — visible, rather than a silent replay next time.
  try {
    await systemDb.insert(paymentWebhookEvents).values({
      provider: provider.name,
      eventId: event.eventId,
      eventType: "payment",
    });
  } catch {
    log.action("payment_webhook.duplicate_skipped", { eventId: event.eventId });
    return { handled: false, reason: "Already processed" };
  }

  const [invoice] = await systemDb
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      status: invoices.status,
    })
    .from(invoices)
    .where(eq(invoices.id, event.invoiceId))
    .limit(1);

  if (!invoice) {
    await markProcessed(provider.name, event.eventId);
    return { handled: false, reason: "No invoice for that payment" };
  }

  // The org comes from the invoice, and everything downstream is scoped by it.
  const organizationId = invoice.organizationId;

  try {
    await recordPayment(organizationId, invoice.id, null, systemAccess(), {
      amount: event.amountCents / 100,
      paymentDate: new Date().toISOString().slice(0, 10),
      method: "credit_card",
      reference: event.reference,
      provider: provider.name,
      providerReference: event.reference,
    });
  } catch (err) {
    // A duplicate payment id trips the unique index on invoice_payments. That
    // is the second line of defence — the event store above is the first — and
    // it firing means the same money arrived under a new event id. Not an
    // error worth retrying.
    const message = err instanceof Error ? err.message : "";
    if (message.includes("invoice_payments_provider_ref_uidx")) {
      log.action("payment_webhook.duplicate_skipped", { eventId: event.eventId, invoiceId: invoice.id });
      await markProcessed(provider.name, event.eventId);
      return { handled: true, invoiceId: invoice.id, duplicate: true };
    }
    log.failure("payment_webhook.processed", err, { eventId: event.eventId, invoiceId: invoice.id });
    throw err;
  }

  log.action("payment_webhook.processed", { eventId: event.eventId, invoiceId: invoice.id });
  await markProcessed(provider.name, event.eventId);
  return { handled: true, invoiceId: invoice.id, duplicate: false };
};

const markProcessed = async (provider: string, eventId: string) => {
  await systemDb
    .update(paymentWebhookEvents)
    .set({ processedAt: new Date() })
    .where(
      and(
        eq(paymentWebhookEvents.provider, provider),
        eq(paymentWebhookEvents.eventId, eventId),
      ),
    );
};
