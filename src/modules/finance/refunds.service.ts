import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { invoicePayments } from "../../db/schema/invoice-payments";
import { invoices } from "../../db/schema/invoices";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { LogEvent } from "../../lib/logging/events";
import { createModuleLogger } from "../../lib/logging/log";
import { confidoCredentialFor } from "../settings/payments/payment-settings.service";
import { getConfidoClient } from "./confido/confido.client";
import { CONFIDO_PROVIDER } from "./confido/confido-webhooks.service";
import type { ConfidoTransaction } from "./confido/confido.types";
import { getById } from "./invoices.service";
import { num, toMoney } from "./money";
import { recordReversal, type ReversalKind } from "./payments.service";
import type { AccountAccess } from "./types";

const log = createModuleLogger("refunds.service");

/**
 * Sending money back to a client.
 *
 * The firm-initiated half of slice 3. The other half — refunds, returns and
 * chargebacks that Confido reports without us asking — lives in
 * `confido-webhooks.service.ts`, and the two converge on the same ledger row
 * through `invoice_payments_provider_ref_uidx`.
 *
 * Authorization is deliberately stricter than recording a payment. A payment
 * recorded wrongly is corrected from the same screen; a refund moves money out
 * of the firm's account and cannot be taken back. The route requires
 * `finance: ["refund"]` — owner and admin only — and a trust-leg refund
 * additionally requires trust write, exactly as taking trust money does.
 */

export type RefundPaymentInput = {
  /**
   * How much to send back. Omitted means everything still left on the payment.
   *
   * This does NOT decide which Confido mutation runs — `isWholeTransaction`
   * does, from the resolved figure. A caller asking for the full amount
   * explicitly gets the same void-capable path as one that omits it.
   */
  amount?: number;
  reason?: string;
};

/**
 * Is this reversal for the entire original transaction?
 *
 * The question that picks the Confido mutation. Reversing the whole thing can
 * be a VOID, which is the only way to touch a payment that has not settled
 * (`PENDING` / `IN_TRANSIT`); anything less has to be a refund, which Confido
 * accepts only once the payment is `DEPOSITED`.
 *
 * A partly reversed payment therefore cannot be voided, and should not be: a
 * transaction with a refund already against it is no longer whole.
 *
 * Exported and pure so the choice can be asserted without standing up a
 * processor stub. 0.005 is the half-cent tolerance used by the payment split
 * and `assertScheduleBalances`.
 */
export const isWholeTransaction = (
  requested: number,
  paymentAmount: number,
): boolean => Math.abs(requested - paymentAmount) < 0.005;

export type RefundOutcome = {
  /** What Confido actually did: a void before settlement, a refund after. */
  executedAs: string;
  status: string;
  /** Rows written here and now. The webhook may confirm them again; that is fine. */
  recorded: number;
  amount: number;
};

export const refundPayment = async (
  organizationId: string,
  invoiceId: string,
  paymentId: string,
  actorStaffId: string | null,
  access: AccountAccess,
  input: RefundPaymentInput,
): Promise<RefundOutcome & { invoice: Awaited<ReturnType<typeof getById>> }> => {
  const [payment] = await db
    .select({
      id: invoicePayments.id,
      invoiceId: invoicePayments.invoiceId,
      amount: invoicePayments.amount,
      kind: invoicePayments.kind,
      provider: invoicePayments.provider,
      providerReference: invoicePayments.providerReference,
      invoiceNumber: invoices.invoiceNumber,
    })
    .from(invoicePayments)
    .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.id, paymentId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    )
    .limit(1);

  if (!payment) throw new NotFoundError("Payment not found");
  if (payment.kind !== "payment") {
    throw new BadRequestError("That entry is already a reversal");
  }

  // A cheque or a cash payment has no processor behind it. Sending that money
  // back is something the firm does at the bank, and claiming otherwise here
  // would write a ledger row for a transfer that never happened.
  if (payment.provider !== CONFIDO_PROVIDER || !payment.providerReference) {
    throw new BadRequestError(
      "This payment was recorded by hand, so there is nothing for the processor to refund. Record the repayment as a manual adjustment instead.",
    );
  }

  // Measured against what is LEFT of the payment, not its gross amount. The
  // gross comparison let the same payment be refunded twice: each request was
  // under the original figure, so each passed, and two reversals went to the
  // processor for money received once.
  const remaining = await unreversedAmount(organizationId, payment.id);
  if (remaining <= 0) {
    throw new BadRequestError("This payment has already been fully refunded");
  }

  const requested = input.amount == null ? remaining : toMoney(input.amount);
  if (requested <= 0) {
    throw new BadRequestError("A refund must be for more than zero");
  }
  if (requested - remaining >= 0.005) {
    throw new BadRequestError(
      "A refund cannot exceed what is left of the payment",
    );
  }

  const { credential } = await confidoCredentialFor(organizationId);

  // Our own idempotency key. Confido requires `externalId` to be unique, so a
  // retry after a network timeout cannot send the money a second time.
  const externalId = randomUUID();

  const result = await getConfidoClient().reverseTransaction(credential, {
    transactionId: payment.providerReference,
    // Chosen by WHAT IS BEING REVERSED, never by how the caller phrased it.
    // Omitting the amount routes to `transactionVoidOrRefund`, the only
    // mutation that can touch a payment which has not settled; sending one
    // forces `transactionRefund`, which Confido accepts only after DEPOSITED.
    //
    // `refundInvoiceInFull` passes an explicit amount even when reversing the
    // whole payment, so deciding on `input.amount != null` meant a cancellation
    // before settlement ALWAYS took the settled-only path and always failed —
    // leaving the client's money owed with a task nobody could complete.
    // Deciding here, on the figure, makes that unreachable from any caller.
    ...(isWholeTransaction(requested, num(payment.amount))
      ? {}
      : { amount: Math.round(requested * 100) }),
    externalId,
  });

  log.action(LogEvent.PAYMENT_REFUNDED, {
    invoiceId,
    paymentId,
    executedAs: result.type,
    status: result.status,
    externalId,
  });

  // Record from the response as well as from the webhook that follows. Relying
  // on the webhook alone risks money moving that our ledger never hears about;
  // relying on this alone misses Confido's AWAITING_RESULT path, where the
  // transactions are not final at the point the mutation returns.
  let recorded = 0;
  for (const txn of result.transactions) {
    if (await recordFromTransaction(organizationId, payment.id, invoiceId, actorStaffId, access, txn, result.type)) {
      recorded += 1;
    }
  }

  if (recorded === 0) {
    // Not an error: Confido accepted the request and will report the
    // transactions by webhook. Logged because the alternative reading — money
    // moved and nothing recorded it — looks identical from here.
    log.warn(LogEvent.PAYMENT_WEBHOOK_TRANSACTION_SKIPPED, {
      invoiceId,
      paymentId,
      status: result.status,
      reason: "reversal_pending_webhook",
    });
  }

  return {
    executedAs: result.type,
    status: result.status,
    recorded,
    amount: requested,
    invoice: await getById(organizationId, invoiceId, access),
  };
};

/**
 * Write one reversing transaction to the ledger.
 *
 * Returns whether a row was written. A duplicate is not a failure — it means
 * the webhook won the race, which is exactly what the unique index is for.
 */
const recordFromTransaction = async (
  organizationId: string,
  paymentId: string,
  invoiceId: string,
  actorStaffId: string | null,
  access: AccountAccess,
  txn: ConfidoTransaction,
  executedAs: string,
): Promise<boolean> => {
  const amount = txn.amountProcessed / 100;
  if (amount <= 0) return false;

  const account =
    txn.bankAccount.category === "trust"
      ? "trust_iolta"
      : txn.bankAccount.category === "operating"
        ? "operating"
        : null;

  if (!account) {
    log.warn(LogEvent.PAYMENT_WEBHOOK_TRANSACTION_SKIPPED, {
      transactionId: txn.id,
      bankAccountCategory: txn.bankAccount.category,
      reason: "unknown_bank_account_category",
    });
    return false;
  }

  try {
    await recordReversal(organizationId, invoiceId, actorStaffId, access, {
      // Confido's own word for what it did, so a void is recorded as a void
      // rather than as the refund the firm asked for.
      kind: executedAs.toLowerCase().includes("void")
        ? ("void" as ReversalKind)
        : ("refund" as ReversalKind),
      reversesPaymentId: paymentId,
      amount,
      account,
      paymentDate: new Date().toISOString().slice(0, 10),
      method: "other",
      reference: txn.id,
      provider: CONFIDO_PROVIDER,
      providerReference: txn.id,
      providerStatus: txn.status_v2,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("invoice_payments_provider_ref_uidx")) return false;
    throw err;
  }
};

// ── Refunding a whole invoice ────────────────────────────────────────────────

export type InvoiceRefundSummary = {
  /** Sent back through the processor, in full. */
  refunded: number;
  /**
   * Money that reached the firm outside Confido — a cheque or cash somebody
   * keyed in — which we have no way to return. The firm owes it and has to
   * settle it at the bank, so it is reported rather than silently dropped.
   */
  manualOutstanding: number;
  /** Per-payment failures, so a partial success is still legible. */
  failures: { paymentId: string; reason: string }[];
};

/**
 * Send back everything still held against one invoice.
 *
 * Written for cancellation, where the caller is undoing a whole transaction
 * rather than choosing a payment to reverse. Each payment is refunded for the
 * amount that has not already been reversed, so running this twice is a no-op
 * rather than a double refund — the second pass finds nothing outstanding.
 *
 * Failures are collected, not thrown. A cancellation must not be blocked
 * because one leg of the refund failed; the caller reports what happened and
 * the remainder stays visible as still owed, which is exactly the state a
 * derived "refund owed" check reads.
 */
export const refundInvoiceInFull = async (
  organizationId: string,
  invoiceId: string,
  actorStaffId: string | null,
  access: AccountAccess,
  reason?: string,
): Promise<InvoiceRefundSummary> => {
  const summary: InvoiceRefundSummary = {
    refunded: 0,
    manualOutstanding: 0,
    failures: [],
  };

  const payments = await db
    .select({
      id: invoicePayments.id,
      amount: invoicePayments.amount,
      provider: invoicePayments.provider,
      providerReference: invoicePayments.providerReference,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.invoiceId, invoiceId),
        eq(invoicePayments.kind, "payment"),
      ),
    );

  for (const payment of payments) {
    const outstanding = await unreversedAmount(organizationId, payment.id);
    if (outstanding <= 0) continue;

    // Nothing to ask a processor for. The money arrived by cheque, cash or
    // wire and goes back the same way.
    if (payment.provider !== CONFIDO_PROVIDER || !payment.providerReference) {
      summary.manualOutstanding = toMoney(
        summary.manualOutstanding + outstanding,
      );
      continue;
    }

    try {
      const result = await refundPayment(
        organizationId,
        invoiceId,
        payment.id,
        actorStaffId,
        access,
        { amount: outstanding, ...(reason ? { reason } : {}) },
      );
      summary.refunded = toMoney(summary.refunded + result.amount);
    } catch (err) {
      summary.failures.push({
        paymentId: payment.id,
        reason: err instanceof Error ? err.message : "Refund failed",
      });
      log.failure(LogEvent.PAYMENT_FAILED, err, { invoiceId, paymentId: payment.id });
    }
  }

  return summary;
};

/** What is left of one payment after everything already reversed against it. */
const unreversedAmount = async (
  organizationId: string,
  paymentId: string,
): Promise<number> => {
  const [payment] = await db
    .select({ amount: invoicePayments.amount })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.id, paymentId),
      ),
    )
    .limit(1);

  if (!payment) return 0;

  const [reversed] = await db
    .select({
      total: sql<string>`coalesce(sum(${invoicePayments.amount}), 0)`,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.reversesPaymentId, paymentId),
      ),
    );

  // Reversal rows are negative; the caller wants a magnitude.
  return Math.max(toMoney(num(payment.amount) - Math.abs(num(reversed?.total))), 0);
};

/**
 * How much of this invoice the firm is still holding.
 *
 * The derived answer to "is a refund owed here". Net of reversals by
 * construction, because a reversal is a negative row — which means it clears
 * itself the moment the refund lands, and cannot drift the way a stored flag
 * would.
 */
export const netPaidOnInvoice = async (
  organizationId: string,
  invoiceId: string,
): Promise<number> => {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${invoicePayments.amount}), 0)`,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    );

  return Math.max(toMoney(num(row?.total)), 0);
};
