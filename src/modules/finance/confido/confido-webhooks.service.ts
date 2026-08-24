import { and, eq, isNull } from "drizzle-orm";
import { LogEvent } from "../../../lib/logging/events";
import { createModuleLogger } from "../../../lib/logging/log";
import { systemDb } from "../../../db/client";
import { paymentWebhookEvents } from "../../../db/schema/payment-webhook-events";
import { enqueueConfidoWebhook } from "../../../queue/queues";
import { invoices, type PaymentMethod } from "../../../db/schema/invoices";
import { systemAccess } from "../account-access";
import { logFinanceEvent } from "../finance-events.service";
import {
  findPaymentByProviderReference,
  markPaymentSettled,
  recordPayment,
  recordReversal,
  type ReversalKind,
} from "../payments.service";
import {
  confidoCredentialFor,
  markWebhookSeen,
  organizationForConfidoFirm,
  refreshStatus,
} from "../../settings/payments/payment-settings.service";
import { getConfidoClient, isConfidoConfigured } from "./confido.client";
import { settleConsultationForInvoice } from "../../leads/leads.service";
import { syncStatements } from "./statements.service";
import type {
  ConfidoTransaction,
  ConfidoWebhookEvent,
} from "./confido.types";

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
  // Money going back out. These four carry a DIFFERENT payload shape to the
  // three above — `originalTransaction` plus a named reversing transaction,
  // with no `transaction` key at all — which is why `transactionIdsOf` had to
  // learn about them rather than silently extracting null.
  "transaction.voided",
  "transaction.refunded",
  "transaction.partially_refunded",
  "transaction.ach_returned",
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

    const ids = transactionIdsOf(event);
    await enqueueConfidoWebhook({
      eventId: event.eventId,
      eventType: event.type,
      firmId: event.firmId,
      ...(ids.transactionId ? { transactionId: ids.transactionId } : {}),
      ...(ids.originalTransactionId
        ? { originalTransactionId: ids.originalTransactionId }
        : {}),
    });
    claimed += 1;
  }

  return { received: events.length, claimed, ignored };
};

/**
 * Dig the transaction ids out of a thin payload.
 *
 * Confido uses two payload shapes and does not flag which is which:
 *
 *   transaction.created / .funds_in_transit / .deposited
 *     → { transaction: { id } }
 *   transaction.voided       → { originalTransaction, voidTransaction }
 *   transaction.refunded     → { originalTransaction, refundTransaction }
 *   .partially_refunded      → { originalTransaction, refundTransaction }
 *   transaction.ach_returned → { originalTransaction, returnTransaction }
 *
 * The reversal shape has no `transaction` key, so reading only that returned
 * null for every one of them — the event was claimed, enqueued, and quietly did
 * nothing, because a missing id is tolerated further down.
 *
 * Typed loosely because the payload is theirs, and a shape change should
 * degrade to "no id" rather than throw inside the five second window.
 */
const transactionIdsOf = (
  event: ConfidoWebhookEvent,
): { transactionId: string | null; originalTransactionId: string | null } => {
  const data = event.data as
    | Record<string, { id?: unknown } | undefined>
    | undefined;

  const idAt = (key: string): string | null => {
    const id = data?.[key]?.id;
    return typeof id === "string" ? id : null;
  };

  return {
    // First match wins; only one of these is ever present.
    transactionId:
      idAt("transaction") ??
      idAt("voidTransaction") ??
      idAt("refundTransaction") ??
      idAt("returnTransaction"),
    originalTransactionId: idAt("originalTransaction"),
  };
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
  originalTransactionId?: string;
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
  } else if (job.originalTransactionId && job.transactionId) {
    // Both ids present means a reversal, whatever the event is called. Keyed on
    // the payload shape rather than the event name so a reversal type Confido
    // adds later still lands somewhere — and because a chargeback, which has no
    // documented event at all, would arrive through `transaction.created`
    // carrying `originalTransactionId` and nothing else to identify it.
    await recordConfidoReversal(
      organizationId,
      job.transactionId,
      job.originalTransactionId,
    );
  } else if (job.eventType === "transaction.created" && job.transactionId) {
    await recordConfidoTransaction(organizationId, job.transactionId);
  } else if (
    job.eventType.startsWith("transaction.") &&
    job.transactionId
  ) {
    // funds_in_transit / deposited. These used to fall through to
    // `recordConfidoTransaction`, hit the replay guard and return — busy work
    // that looked like handling. They now do the one job they are good for.
    await advanceSettlement(organizationId, job.transactionId);
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

  // A transaction that names another is money going back out, whatever it is
  // called. Checked here as well as at dispatch because a chargeback has NO
  // documented webhook of its own — if one reaches us at all it arrives as an
  // ordinary `transaction.created`, and this is the only thing that would
  // recognise it.
  if (txn.originalTransactionId) {
    await recordReversalFromTransaction(
      organizationId,
      txn,
      txn.originalTransactionId,
    );
    return;
  }

  // Not invoice revenue. A standalone surcharge in particular references the
  // same payment link, and recording it as a payment overpays the invoice and
  // marks it settled.
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

  // Money against an invoice that has since been VOIDED.
  //
  // `recordPayment` refuses one by design, and that refusal is right — a
  // withdrawn invoice must not collect. But its `BadRequestError` used to
  // escape the catch below, which only swallows the uniqueness guard, so the
  // job failed and BullMQ retried it. The invoice stays void, so no attempt
  // could ever succeed: the retries only delayed the moment a person found out
  // that money had moved and nothing had recorded it.
  //
  // Not preventable at Confido either. `removePaymentLink` is rejected once a
  // link has any transaction against it, which is exactly the partially-paid
  // invoice most likely to be voided — so `retirePaymentLink` cannot close this
  // door and this path, not that one, is the real guard.
  //
  // Handled rather than thrown: recorded where a person will see it, then
  // finished, so the job completes.
  const [invoice] = await systemDb
    .select({ status: invoices.status, number: invoices.invoiceNumber })
    .from(invoices)
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)),
    )
    .limit(1);

  if (invoice?.status === "void") {
    log.failure(
      LogEvent.PAYMENT_WEBHOOK_VOIDED_INVOICE_PAYMENT,
      new Error("Payment received against a voided invoice"),
      { organizationId, invoiceId, transactionId, amount },
    );

    // The operator log is not enough on its own — the firm is the one who has
    // to give this money back, and the invoice's own trail is where they will
    // be looking.
    await logFinanceEvent({
      organizationId,
      action: "finance.payment_recorded",
      title: `${invoice.number} — payment received after voiding`,
      description:
        "A client paid this invoice at the payment processor after it was voided. " +
        "It has NOT been credited to the invoice and will need to be refunded.",
      amount,
      invoiceId,
      // No actor: nobody did this, it arrived. Matches how `recordPayment`
      // attributes a webhook-driven payment.
      actorId: null,
      metadata: {
        transactionId,
        providerPaymentId: txn.payment?.id ?? null,
      },
    }).catch((err) =>
      // The finance trail is the notification, but failing to write it must not
      // resurrect the retry loop this guard exists to end.
      log.failure(LogEvent.FINANCE_EVENT_QUERY_FAILED, err, { invoiceId }),
    );

    return;
  }

  try {
    await recordPayment(organizationId, invoiceId, null, systemAccess(), {
      amount,
      paymentDate: new Date().toISOString().slice(0, 10),
      method: methodFor(txn.type),
      reference: txn.payment?.id ?? txn.id,
      provider: CONFIDO_PROVIDER,
      legs: [{ account, amount, providerReference: txn.id }],
      // Usually null — a card lands PENDING and deposits about two business
      // days later. Read rather than assumed because an API-recorded manual
      // payment is DEPOSITED from the outset, and a payment that never gets a
      // settlement event would otherwise sit unsettled forever.
      settledAt: settledAtFor(txn),
      providerStatus: txn.status_v2,
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

/**
 * Statuses that mean the money is in the firm's bank account.
 *
 * `DEPOSITED` only. `SUCCESSFUL` looks like a candidate and is deliberately not
 * one: it is set while a card authorisation has succeeded but the batch has not
 * deposited, which is exactly the window in which a payment can still be
 * voided — the window the case-opening gate exists to respect. Confirmed
 * shapes are recorded by `19-confido-reversals`.
 */
const SETTLED_STATUSES = new Set(["DEPOSITED"]);

/**
 * Statuses that mean this money is never arriving.
 *
 * Distinct from "not settled yet": a returned or voided payment is finished,
 * and leaving it looking in-flight would hold a case open forever under a
 * clearing policy that waits.
 */
const DEAD_STATUSES = new Set([
  "RETURNED",
  "VOIDED",
  "REFUNDED",
  "CHARGED_BACK",
  "ERROR",
]);

const settledAtFor = (txn: ConfidoTransaction): Date | null => {
  if (!SETTLED_STATUSES.has(txn.status_v2)) return null;
  // Their own settlement date when they give one, so the ledger records when
  // the money landed rather than when we happened to hear about it.
  const parsed = txn.settledOn ? new Date(txn.settledOn) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
};

/**
 * Which of our reversal kinds a Confido transaction represents.
 *
 * Their `type` is an untyped String, so this is a mapping with a fallback
 * rather than an exhaustive switch. `reversal` is the honest answer for a type
 * we have not seen: the money moved either way, and refusing to record it
 * because we cannot name it would leave the ledger wrong.
 */
const reversalKindFor = (txn: ConfidoTransaction): ReversalKind => {
  const type = txn.type.toLowerCase();
  if (type.includes("return")) return "return";
  if (type.includes("chargeback")) return "chargeback";
  if (type.includes("void")) return "void";
  if (type.includes("refund")) return "refund";
  // A returned ACH always carries a return code, even if the type is worded in
  // a way this does not recognise.
  if (txn.achReturnCode) return "return";
  if (txn.status_v2 === "CHARGED_BACK") return "chargeback";
  if (txn.status_v2 === "VOIDED") return "void";
  return "reversal";
};

/**
 * A reversal webhook: fetch the reversing transaction, then record it.
 *
 * The event names both ids, so the original is known without a second call —
 * but the reversing transaction still has to be fetched for its amount, its
 * account and its ACH return code, none of which the payload carries.
 */
const recordConfidoReversal = async (
  organizationId: string,
  reversalTransactionId: string,
  originalTransactionId: string,
): Promise<void> => {
  const { credential } = await confidoCredentialFor(organizationId);
  const txn = await getConfidoClient().getTransaction(
    credential,
    reversalTransactionId,
  );
  await recordReversalFromTransaction(organizationId, txn, originalTransactionId);
};

/**
 * Record money going back out, from the reversing transaction itself.
 *
 * Shared by the four reversal webhooks and by `transaction.created`, since a
 * chargeback can only reach us through the latter.
 */
const recordReversalFromTransaction = async (
  organizationId: string,
  txn: ConfidoTransaction,
  originalTransactionId: string,
): Promise<void> => {
  const original = await findPaymentByProviderReference(
    organizationId,
    CONFIDO_PROVIDER,
    originalTransactionId,
  );

  // A reversal of a payment we never recorded is a reconciliation exception,
  // not a ledger entry. Subtracting money we never added would drive
  // `amount_paid` negative and mark a paid invoice unpaid — worse than an
  // unexplained line a human has to look at. Logged at warn so it is visible
  // rather than silent.
  if (!original) {
    log.warn("payment_webhook.transaction_skipped", {
      transactionId: txn.id,
      originalTransactionId,
      transactionType: txn.type,
      reason: "reversal_of_unrecorded_payment",
    });
    return;
  }

  const account = accountFor(txn.bankAccount.category);
  if (!account) {
    log.warn("payment_webhook.transaction_skipped", {
      transactionId: txn.id,
      bankAccountCategory: txn.bankAccount.category,
      reason: "unknown_bank_account_category",
    });
    return;
  }

  // Positive on their side — a return is a separate transaction with a positive
  // amount — and negated by `recordReversal`, which owns the sign convention.
  const amount = txn.amountProcessed / 100;
  if (amount <= 0) return;

  try {
    await recordReversal(organizationId, original.invoiceId, null, systemAccess(), {
      kind: reversalKindFor(txn),
      reversesPaymentId: original.id,
      amount,
      account,
      paymentDate: new Date().toISOString().slice(0, 10),
      method: methodFor(txn.type),
      reference: txn.payment?.id ?? txn.id,
      ...(txn.achReturnCode
        ? {
            notes: `${txn.achReturnCode} — ${txn.achReturnReason ?? "returned"}`,
          }
        : {}),
      provider: CONFIDO_PROVIDER,
      providerReference: txn.id,
      providerStatus: txn.status_v2,
    });
  } catch (err) {
    // Already recorded: the firm-initiated refund path wrote it from the
    // mutation's own response before this webhook arrived. That double write is
    // deliberate; this is where it collapses.
    const message = err instanceof Error ? err.message : "";
    if (message.includes("invoice_payments_provider_ref_uidx")) return;
    throw err;
  }
};

/**
 * Move a payment along its settlement lifecycle.
 *
 * What `transaction.funds_in_transit` and `transaction.deposited` are actually
 * for. They previously fell through to the recording path, hit the replay guard
 * and returned — which looked like handling and achieved nothing, leaving every
 * provider payment permanently unsettled.
 */
const advanceSettlement = async (
  organizationId: string,
  transactionId: string,
): Promise<void> => {
  const { credential } = await confidoCredentialFor(organizationId);
  const txn = await getConfidoClient().getTransaction(credential, transactionId);

  const found = await markPaymentSettled(
    organizationId,
    CONFIDO_PROVIDER,
    txn.id,
    txn.status_v2,
    SETTLED_STATUSES.has(txn.status_v2),
  );

  if (!found) {
    // A settlement event for a transaction we never booked. Usually benign —
    // a surcharge leg, or a payment against a link we did not issue — but it is
    // the same shape as a lost `transaction.created`, so it is worth seeing.
    log.warn("payment_webhook.transaction_skipped", {
      transactionId,
      status: txn.status_v2,
      reason: "settlement_for_unrecorded_payment",
    });
    return;
  }

  if (DEAD_STATUSES.has(txn.status_v2) && txn.originalTransactionId == null) {
    // The payment itself has gone terminal without a reversing transaction we
    // have seen. The reversal event should follow; if it never does, this line
    // is what explains an invoice whose money quietly stopped being real.
    log.warn("payment_webhook.transaction_skipped", {
      transactionId,
      status: txn.status_v2,
      reason: "payment_terminal_without_reversal",
    });
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
