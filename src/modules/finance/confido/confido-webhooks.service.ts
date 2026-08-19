import { and, eq, isNull } from "drizzle-orm";
import { LogEvent } from "../../../lib/logging/events";
import { createModuleLogger } from "../../../lib/logging/log";
import { systemDb } from "../../../db/client";
import { paymentWebhookEvents } from "../../../db/schema/payment-webhook-events";
import { enqueueConfidoWebhook } from "../../../queue/queues";
import type { PaymentMethod } from "../../../db/schema/invoices";
import { systemAccess } from "../account-access";
import { recordPayment } from "../payments.service";
import {
  confidoCredentialFor,
  markWebhookSeen,
  organizationForConfidoFirm,
  refreshStatus,
} from "../../settings/payments/payment-settings.service";
import { getConfidoClient, isConfidoConfigured } from "./confido.client";
import { settleConsultationForInvoice } from "../../leads/leads.service";
import { syncStatements } from "./statements.service";
import type { ConfidoWebhookEvent } from "./confido.types";

const log = createModuleLogger("confido-webhooks.service");

/**
 * Confido webhooks.
 *
 * Three properties of their delivery shape the design, and none of them match
 * the Stripe-silhouetted handler in `payment-webhooks.service.ts`:
 *
 *   1. **A five-second budget.** A slower answer is marked failed, and repeated
 *      failures over 24 hours disable the webhook URL — recoverable only from
 *      their portal. So the HTTP path does no network I/O at all: verify, claim,
 *      enqueue, return.
 *   2. **The body is an array** of heterogeneous events, not one event.
 *   3. **Payloads are thin.** `firm.updated` carries `{ firm: { id } }` and
 *      nothing else, so the state must be fetched rather than read. That is also
 *      what makes out-of-order delivery harmless: every handler converges on the
 *      current truth instead of writing whatever the payload happened to say.
 *
 * This is the single Confido endpoint. Confido posts every event type to one
 * Partner-level URL, so slice 2's transaction events land here too.
 */

export const CONFIDO_PROVIDER = "confido";

/** Event types we act on. Anything else is acknowledged and dropped. */
const HANDLED_TYPES = new Set([
  "firm.updated",
  // The ledger write. Settlement events only advance status.
  "transaction.created",
  "transaction.funds_in_transit",
  "transaction.deposited",
  // Reconciliation: the monthly fee debit never reaches invoice_payments, so
  // the statement is the only thing that explains the operating balance.
  "statement.created",
  "statement.updated",
]);

/**
 * Transaction types that represent a client paying an invoice.
 *
 * An allowlist rather than a denylist, deliberately. Money arriving at an
 * invoice is not always revenue for it: a surcharge can land as its own
 * operating transaction against a trust-only link, and refunds, returns and
 * chargebacks all reference the same payment link. Recording one of those as a
 * payment overpays the invoice and marks it settled — a ledger bug that fails
 * silently rather than loudly, which is the worst kind. Anything unrecognised
 * is logged and skipped so it is visible rather than booked.
 */
const PAYMENT_TRANSACTION_TYPES = new Set([
  "ccPayment",
  "achPayment",
  "manualPayment",
]);

export type ConfidoWebhookOutcome = {
  received: number;
  claimed: number;
  ignored: number;
};

/** Narrow an unknown parsed body to the events we can act on. */
const asEvents = (parsed: unknown): ConfidoWebhookEvent[] => {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(
    (e): e is ConfidoWebhookEvent =>
      Boolean(e) &&
      typeof e === "object" &&
      typeof (e as ConfidoWebhookEvent).type === "string" &&
      typeof (e as ConfidoWebhookEvent).eventId === "string",
  );
};

/**
 * The HTTP path. Verifies, claims, enqueues — and touches no network.
 *
 * Throws on an unverifiable signature so the route can answer 401. Everything
 * else returns a summary and a 200: an unrecognised event type is not an error,
 * and answering non-2xx would make Confido retry something we will never handle.
 */
export const receiveConfidoWebhook = async (
  rawBody: Buffer,
  signature: string | undefined,
): Promise<ConfidoWebhookOutcome> => {
  if (!isConfidoConfigured()) {
    // Nothing to verify with, so nothing can be trusted. Refusing is the only
    // safe answer for an unauthenticated endpoint.
    throw new Error("Confido is not configured");
  }

  if (!getConfidoClient().verifyWebhook(rawBody, signature)) {
    throw new Error("Invalid webhook signature");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new Error("Malformed webhook body");
  }

  const events = asEvents(parsed);
  let claimed = 0;
  let ignored = 0;

  for (const event of events) {
    if (!HANDLED_TYPES.has(event.type)) {
      // Deliberately no row. Slice 2 adds the transaction branches, and it must
      // find those events unclaimed rather than pre-marked as processed.
      ignored += 1;
      continue;
    }

    try {
      await systemDb.insert(paymentWebhookEvents).values({
        provider: CONFIDO_PROVIDER,
        eventId: event.eventId,
        eventType: event.type,
      });
    } catch {
      // The unique index fired: a redelivery. Confido reuses the event id on
      // resend, which is exactly what makes this safe.
      continue;
    }

    await enqueueConfidoWebhook({
      eventId: event.eventId,
      eventType: event.type,
      firmId: event.firmId,
      ...(transactionIdOf(event) ? { transactionId: transactionIdOf(event)! } : {}),
    });
    claimed += 1;
  }

  return { received: events.length, claimed, ignored };
};

/**
 * Dig the transaction id out of a thin payload.
 *
 * `transaction.created` nests it as `{ transaction: { id } }`; the settlement
 * events use the same shape. Typed loosely because the payload is theirs, and a
 * shape change should degrade to "no id" rather than throw inside the five
 * second window.
 */
const transactionIdOf = (event: ConfidoWebhookEvent): string | null => {
  const txn = (event.data as { transaction?: { id?: unknown } } | undefined)
    ?.transaction;
  return typeof txn?.id === "string" ? txn.id : null;
};

/**
 * The worker's side. Runs outside any request context.
 *
 * `db` would silently fall back to `systemDb` here, so the services this calls
 * use `systemDb` explicitly and resolve the organization from `confido_firm_id`.
 * A wrong mapping would be a cross-tenant write, which is why that column is
 * uniquely indexed.
 */
export const processConfidoWebhook = async (job: {
  eventId: string;
  eventType: string;
  firmId: string;
  transactionId?: string;
}): Promise<void> => {
  const organizationId = await organizationForConfidoFirm(job.firmId);

  if (!organizationId) {
    // Not an error. A Partner-level URL legitimately receives events for firms
    // created outside this application.
    await markProcessed(job.eventId);
    return;
  }

  await markWebhookSeen(organizationId);

  if (job.eventType === "firm.updated") {
    await refreshStatus(organizationId);
  } else if (job.eventType.startsWith("transaction.") && job.transactionId) {
    await recordConfidoTransaction(organizationId, job.transactionId);
  } else if (job.eventType.startsWith("statement.")) {
    await syncStatements(organizationId);
  }

  await markProcessed(job.eventId);
};

/**
 * Closes the event out.
 *
 * Only ever moves a null `processed_at` forward, so a redelivery that raced
 * ahead cannot rewind the timestamp. A row left null is one that crashed
 * mid-handle — visible rather than silently replayed.
 */
const markProcessed = async (eventId: string): Promise<void> => {
  await systemDb
    .update(paymentWebhookEvents)
    .set({ processedAt: new Date() })
    .where(
      and(
        eq(paymentWebhookEvents.provider, CONFIDO_PROVIDER),
        eq(paymentWebhookEvents.eventId, eventId),
        isNull(paymentWebhookEvents.processedAt),
      ),
    );
};


/**
 * Turn one Confido transaction into a ledger row.
 *
 * Confido credits one bank account per transaction, so a payment split across
 * trust and operating arrives as two events and becomes two single-sided rows —
 * each carrying its own transaction id as `providerReference`, which is what
 * keeps `invoice_payments_provider_ref_uidx` working as the replay guard per
 * leg rather than per payment.
 *
 * Every early return here is a decision not to book money, and each one is a
 * case where booking it would be wrong rather than merely unnecessary.
 */
const recordConfidoTransaction = async (
  organizationId: string,
  transactionId: string,
): Promise<void> => {
  const { credential } = await confidoCredentialFor(organizationId);
  const txn = await getConfidoClient().getTransaction(credential, transactionId);

  // Not invoice revenue. A standalone surcharge, a refund, a return or a
  // chargeback all reference the same payment link, and recording any of them
  // as a payment overpays the invoice and marks it settled.
  if (!PAYMENT_TRANSACTION_TYPES.has(txn.type)) {
    log.warn("payment_webhook.transaction_skipped", {
      transactionId,
      transactionType: txn.type,
      reason: "not_a_client_payment",
    });
    return;
  }

  // Our invoice id rides on the link's externalId. A transaction with no link
  // came from a standing link or a stored payment method — real money, but not
  // against an invoice we issued, so there is nothing to credit.
  const invoiceId = txn.paymentLink?.externalId;
  if (!invoiceId) {
    log.warn("payment_webhook.transaction_skipped", {
      transactionId,
      reason: "no_invoice_reference",
    });
    return;
  }

  const account = accountFor(txn.bankAccount.category);
  if (!account) {
    // An unrecognised category cannot be assigned to a side, and guessing would
    // put client money in the firm's revenue or vice versa.
    log.warn("payment_webhook.transaction_skipped", {
      transactionId,
      bankAccountCategory: txn.bankAccount.category,
      reason: "unknown_bank_account_category",
    });
    return;
  }

  // Cents to money. `amountProcessed` deliberately excludes any surcharge, so
  // this is what the invoice is actually credited.
  const amount = txn.amountProcessed / 100;
  if (amount <= 0) return;

  try {
    await recordPayment(organizationId, invoiceId, null, systemAccess(), {
      amount,
      paymentDate: new Date().toISOString().slice(0, 10),
      method: methodFor(txn.type),
      reference: txn.payment?.id ?? txn.id,
      provider: CONFIDO_PROVIDER,
      legs: [{ account, amount, providerReference: txn.id }],
    });
  } catch (err) {
    // The ledger's own uniqueness guard firing means this leg is already
    // recorded — a redelivery that outran the event claim. Not an error.
    const message = err instanceof Error ? err.message : "";
    if (message.includes("invoice_payments_provider_ref_uidx")) return;
    throw err;
  }

  // A consultation fee that is now settled moves the consultation on — unlocking
  // slot selection, scheduling an urgent call, or beginning an instant one.
  // Downstream of money actually arriving, rather than of a button being
  // clicked, which is the whole point of moving it here. Idempotent, and
  // non-fatal: a consultation that fails to advance is recoverable, a payment
  // that fails to record is not.
  try {
    await settleConsultationForInvoice(organizationId, invoiceId);
  } catch (err) {
    log.failure(
      LogEvent.PAYMENT_WEBHOOK_CONSULTATION_SETTLEMENT_FAILED,
      err,
      { invoiceId, organizationId },
    );
  }
};

/** Confido's untyped `category` string onto our account enum. */
const accountFor = (
  category: string,
): "operating" | "trust_iolta" | null => {
  if (category === "operating") return "operating";
  if (category === "trust") return "trust_iolta";
  return null;
};

/** Their transaction type onto our payment-method enum. */
const methodFor = (type: string): PaymentMethod => {
  if (type === "achPayment") return "bank_transfer";
  if (type === "ccPayment") return "credit_card";
  return "other";
};
