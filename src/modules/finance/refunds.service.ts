import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
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
   * How much to send back. Omitted means all of it.
   *
   * A partial can only be expressed by `transactionRefund`, which Confido
   * accepts only after settlement — so a partial refund of a payment that has
   * not cleared is refused by them, correctly.
   */
  amount?: number;
  reason?: string;
};

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

  const full = input.amount == null;
  const requested = full ? num(payment.amount) : toMoney(input.amount!);
  if (requested <= 0) {
    throw new BadRequestError("A refund must be for more than zero");
  }
  if (requested - num(payment.amount) >= 0.005) {
    throw new BadRequestError("A refund cannot exceed the payment");
  }

  const { credential } = await confidoCredentialFor(organizationId);

  // Our own idempotency key. Confido requires `externalId` to be unique, so a
  // retry after a network timeout cannot send the money a second time.
  const externalId = randomUUID();

  const result = await getConfidoClient().reverseTransaction(credential, {
    transactionId: payment.providerReference,
    ...(full ? {} : { amount: Math.round(requested * 100) }),
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
