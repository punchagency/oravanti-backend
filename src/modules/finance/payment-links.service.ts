import { createHash, randomBytes } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { db, systemDb } from "../../db/client";
import { invoiceInstalments } from "../../db/schema/invoice-instalments";
import { invoicePayments } from "../../db/schema/invoice-payments";
import { invoices } from "../../db/schema/invoices";
import { LogEvent } from "../../lib/logging/events";
import { createModuleLogger } from "../../lib/logging/log";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { onClient, onLead, partyEmail, partyName } from "./party";
import { clients } from "../../db/schema/clients";
import { leads } from "../../db/schema/leads";
import { allocate } from "./instalments";
import { num, trustFirstSplit } from "./money";
import { paymentsEnabledFor } from "./confido/payments-enabled";
import { getConfidoClient } from "./confido/confido.client";
import { confidoCredentialFor } from "../settings/payments/payment-settings.service";

const log = createModuleLogger("payment-links.service");

/**
 * Client-facing payment links.
 *
 * Hash-only, matching consultation booking and document requests: the raw token
 * is returned once, to be emailed, and only its SHA-256 is stored. That means
 * the link cannot be recovered from the database, and resending has to mint a
 * new one — which retires the old. Rotation is the price of never holding the
 * raw value, and it is the right price for a link that takes money.
 *
 * Deliberately NOT the fee-agreement pattern, which stores a `randomUUID()` in
 * plaintext with no expiry.
 */

const LINK_TTL_DAYS = 30;

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** 256 bits, url-safe. `randomUUID()` is 122 bits and not meant as a secret. */
const generateToken = () => randomBytes(32).toString("base64url");

export const paymentLinkFor = (token: string) =>
  `${env.FRONTEND_APP_URL}/invoice-payment/${token}`;

/**
 * Mint a fresh link, returning the raw token exactly once.
 *
 * Called on every send and resend. The previous link stops working, which is
 * the intended behaviour: a client holding two links to the same invoice, one
 * of them stale, is worse than one that says it expired.
 */
export const mintPaymentLink = async (
  organizationId: string,
  invoiceId: string,
): Promise<string> => {
  const token = generateToken();
  await db
    .update(invoices)
    .set({
      paymentTokenHash: tokenHash(token),
      paymentLinkExpiresAt: new Date(
        Date.now() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000,
      ),
      updatedAt: new Date(),
    })
    .where(
      and(eq(invoices.organizationId, organizationId), eq(invoices.id, invoiceId)),
    );

  log.action("payment_link.created", { invoiceId });

  return token;
};

export type PayableInvoice = {
  invoiceId: string;
  organizationId: string;
  invoiceNumber: string;
  payerName: string;
  payerEmail: string | null;
  total: number;
  amountPaid: number;
  balanceDue: number;
  /**
   * What this payment is FOR — the next unpaid instalment when the invoice is
   * on a schedule, the whole balance otherwise.
   *
   * Distinct from `balanceDue`, and the distinction is the point. A
   * consultation billed as a deposit plus a balance owes the whole fee, but is
   * only being ASKED for the deposit right now. Quoting the balance would ask
   * for money that is not due yet and contradict the invoice the client is
   * looking at.
   */
  amountDueNow: number;
  dueDate: string;
  status: string;
  /** False while this firm cannot take money — the page says so rather than lying. */
  paymentsEnabled: boolean;
  /**
   * True once nothing is owed.
   *
   * Returned rather than thrown, because the payment page POLLS this while a
   * card is being processed. Throwing the moment the balance clears would flip
   * the page into "this link is not available" at exactly the moment the payment
   * succeeded — the one instant the payer most needs reassurance.
   */
  settled: boolean;
  /**
   * Our uuid for whoever is billed — the client, or the lead if no client row
   * exists yet. Becomes the Confido payer's `externalId`, which is what lets us
   * map without a table of our own.
   */
  payerExternalId: string;
};

/**
 * Resolve a payment link, for the public page.
 *
 * Guard vocabulary copied from `getConsultationByBookingToken`: not found,
 * expired, and states where paying makes no sense. A voided invoice is refused
 * rather than silently accepting money against it.
 *
 * A SETTLED invoice is deliberately not refused. The page polls this while the
 * payer is watching their card go through, so throwing the moment the balance
 * reaches zero would flip them into an error card at the exact instant they
 * succeeded. It returns `settled: true` instead and the page renders it;
 * `startCheckout` carries the refusal, which is where it belongs — that is the
 * call that would take money against nothing owed.
 */
/**
 * What the client is being asked for right now.
 *
 * An invoice on a schedule is owed in slices: the next unpaid one is what a
 * payment link should ask for, not the whole balance. Without this a
 * consultation billed as "deposit now, balance after" quoted the full fee on
 * the payment page while the invoice beside it showed two instalments — the
 * page and the invoice disagreeing about the same debt.
 *
 * Falls back to the whole balance when there is no schedule, which is every
 * ordinary invoice.
 *
 * Reuses `allocate` rather than re-deriving: instalment payment state is a fold
 * over `amount_paid` in due-date order, and that arithmetic already exists in
 * two places that must agree (`instalments.ts` and the SQL in `dues.ts`). A
 * third copy here would be a third thing to keep in step.
 */
const amountDueNow = async (
  organizationId: string,
  invoiceId: string,
  amountPaid: number,
  balanceDue: number,
): Promise<number> => {
  const schedule = await systemDb
    .select({
      sequence: invoiceInstalments.sequence,
      dueDate: invoiceInstalments.dueDate,
      amount: invoiceInstalments.amount,
    })
    .from(invoiceInstalments)
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        eq(invoiceInstalments.invoiceId, invoiceId),
      ),
    );

  if (!schedule.length) return Math.max(balanceDue, 0);

  const next = allocate(
    schedule.map((row) => ({ ...row, amount: num(row.amount) })),
    amountPaid,
  ).find((row) => row.outstanding > 0);

  // Every slice covered but a balance somehow remaining: trust the balance.
  // `assertScheduleBalances` makes this unreachable, but guessing zero here
  // would silently refuse to collect real money.
  return next ? next.outstanding : Math.max(balanceDue, 0);
};

export const invoiceByPaymentToken = async (
  token: string,
): Promise<PayableInvoice> => {
  const [row] = await db
    .select({
      id: invoices.id,
      organizationId: invoices.organizationId,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      totalAmount: invoices.totalAmount,
      amountPaid: invoices.amountPaid,
      balanceDue: invoices.balanceDue,
      dueDate: invoices.dueDate,
      expiresAt: invoices.paymentLinkExpiresAt,
      payerName: partyName,
      payerEmail: partyEmail,
      clientId: invoices.clientId,
      leadId: invoices.leadId,
    })
    .from(invoices)
    .leftJoin(clients, onClient)
    .leftJoin(leads, onLead)
    .where(eq(invoices.paymentTokenHash, tokenHash(token)))
    .limit(1);

  if (!row) { log.warn("payment_link.expired", { reason: "not found" }); throw new NotFoundError("Payment link not found"); }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    log.warn("payment_link.expired", { reason: "link expired" });
    throw new BadRequestError("This payment link has expired");
  }
  if (row.status === "void") {
    log.warn("payment_link.expired", { reason: "invoice voided" });
    throw new BadRequestError("This invoice has been cancelled");
  }
  if (row.status === "refunded") {
    log.warn("payment_link.expired", { reason: "invoice refunded" });
    throw new BadRequestError("This invoice has been refunded");
  }
  if (row.status === "draft") {
    log.warn("payment_link.expired", { reason: "invoice draft" });
    throw new BadRequestError("This invoice is not ready for payment");
  }

  return {
    invoiceId: row.id,
    organizationId: row.organizationId,
    invoiceNumber: row.invoiceNumber,
    payerName: row.payerName,
    payerEmail: row.payerEmail,
    total: num(row.totalAmount),
    amountPaid: num(row.amountPaid),
    balanceDue: num(row.balanceDue),
    amountDueNow: await amountDueNow(
      row.organizationId,
      row.id,
      num(row.amountPaid),
      num(row.balanceDue),
    ),
    dueDate: row.dueDate,
    status: row.status,
    settled: num(row.balanceDue) <= 0,
    paymentsEnabled: await paymentsEnabledFor(row.organizationId),
    payerExternalId: row.clientId ?? row.leadId!,
  };
};

/**
 * Start a checkout for a payment link.
 *
 * **Refuses outright when no provider is configured.** It would be easy to have
 * the stub "succeed" here and mark the invoice paid — that is exactly what the
 * consultation booking page does today — but this writes to the ledger, and a
 * payment recorded against money that never moved is worse than a button that
 * says it is not available yet.
 */
export const startCheckout = async (token: string) => {
  const invoice = await invoiceByPaymentToken(token);

  // The guard `invoiceByPaymentToken` used to carry. Resolving a settled
  // invoice is fine — the page needs to say "paid" — but taking money against
  // one is not.
  if (invoice.settled) {
    throw new BadRequestError("This invoice has already been paid in full");
  }

  if (!(await paymentsEnabledFor(invoice.organizationId))) {
    throw new BadRequestError(
      "Online payment is not available yet. Please contact the firm to arrange payment.",
    );
  }

  const link = await ensurePaymentLink(invoice);
  return { url: link.url, reference: link.id };
};

/**
 * The Confido payment link for an invoice — found, or created once.
 *
 * Created lazily rather than at send time, so an invoice nobody opens costs
 * nothing at Confido and a Confido outage cannot block sending an invoice.
 *
 * Idempotency is `externalId` = our invoice id, which is why the lookup comes
 * first. `addPaymentLink` has no idempotency key and Confido has no delete
 * endpoint, so a second create against the same invoice is permanent — the
 * lookup is not an optimisation, it is the guard.
 */
const ensurePaymentLink = async (invoice: PayableInvoice) => {
  const { credential, firmId } = await confidoCredentialFor(
    invoice.organizationId,
  );
  const client = getConfidoClient();

  // What to ask for: the next unpaid instalment, or the whole balance. Split
  // trust-first, the same rule `recordPayment` uses when the money lands, so
  // the link asks for the legs the payment will be allocated to.
  const outstanding = await outstandingBySide(
    invoice.organizationId,
    invoice.invoiceId,
  );
  const legs = trustFirstSplit(
    invoice.amountDueNow,
    outstanding.operating,
    outstanding.trust,
  );

  const amounts = {
    // Cents, and only the sides actually owed — a zero leg would ask Confido to
    // route money to an account this invoice has no claim on.
    ...(legs.trust > 0 ? { trust: Math.round(legs.trust * 100) } : {}),
    ...(legs.operating > 0
      ? { operating: Math.round(legs.operating * 100) }
      : {}),
    // The payer settles what they were invoiced, not an amount they choose.
    // Confido's default lets them edit the figure, which on a consultation fee
    // means underpaying a booking gate that then never opens. A firm-level
    // "accept partial payments" setting can revisit this later; until one
    // exists, the invoiced amount is the amount.
    partialPaymentAllowed: false,
  };

  const existing = await client.findPaymentLinkByExternalId(
    credential,
    invoice.invoiceId,
  );

  if (existing) {
    // The link is created once and the amount due moves — an invoice on a
    // schedule asks for the deposit first and the balance later. Without this
    // the link would be stuck asking for the deposit forever, and the second
    // instalment would be unpayable through it.
    const asked = existing.amounts.reduce((sum, leg) => sum + leg.amount, 0);
    const wanted =
      (amounts.trust ?? 0) + (amounts.operating ?? 0);

    if (asked === wanted) return existing;

    log.action("payment_link.created", {
      invoiceId: invoice.invoiceId,
      reason: "amount_due_changed",
      from: asked,
      to: wanted,
    });
    return client.updatePaymentLink(credential, {
      id: existing.id,
      ...amounts,
    });
  }

  const payer = await ensurePayer(credential, firmId, invoice);

  return client.addPaymentLink(credential, {
    clientId: payer.id,
    externalId: invoice.invoiceId,
    ...amounts,
    memo: `Invoice ${invoice.invoiceNumber}`,
    // Confido emails the receipt. Ours would be a second one saying the same
    // thing, and theirs carries the card details we do not hold.
    sendReceipts: true,
  });
};

/**
 * The Confido payer standing for whoever this invoice bills.
 *
 * An invoice bills a client or a lead, never both — `invoices_one_billed_party`
 * enforces it — and consultation invoices are raised against a lead because no
 * client row exists that early. Confido needs a Client either way, so our uuid
 * for whichever party it is becomes the `externalId`.
 *
 * No mapping table: the lookup is the mapping, and it survives `openCase`
 * repointing the invoice from lead to client (the lead-keyed payer simply stops
 * being referenced).
 */
const ensurePayer = async (
  firmToken: string,
  firmId: string,
  invoice: PayableInvoice,
) => {
  const client = getConfidoClient();
  const existing = await client.findClientByExternalId(
    firmToken,
    invoice.payerExternalId,
  );
  if (existing) return existing;

  return client.createClient(firmToken, {
    firmId,
    clientName: invoice.payerName,
    externalId: invoice.payerExternalId,
    ...(invoice.payerEmail ? { email: invoice.payerEmail } : {}),
  });
};

/**
 * What each side of the invoice still owes.
 *
 * Drives the link's trust/operating split, so the client is asked for the right
 * amount against the right account. Reads through `systemDb` with an explicit
 * organization predicate: this runs on the public payment route, which has no
 * request context and therefore no RLS.
 */
const outstandingBySide = async (
  organizationId: string,
  invoiceId: string,
): Promise<{ operating: number; trust: number }> => {
  const [totals] = await systemDb
    .select({
      operating: invoices.subtotalOperating,
      trust: invoices.subtotalTrust,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, organizationId),
        eq(invoices.id, invoiceId),
      ),
    )
    .limit(1);

  const [paid] = await systemDb
    .select({
      operating: sql<string>`coalesce(sum(${invoicePayments.amountOperating}), 0)`,
      trust: sql<string>`coalesce(sum(${invoicePayments.amountTrust}), 0)`,
    })
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.organizationId, organizationId),
        eq(invoicePayments.invoiceId, invoiceId),
      ),
    );

  return {
    operating: Math.max(num(totals?.operating) - num(paid?.operating), 0),
    trust: Math.max(num(totals?.trust) - num(paid?.trust), 0),
  };
};

/**
 * Withdraw an invoice's payment link so it can no longer take money.
 *
 * Called when an invoice is VOIDED. `invoiceByPaymentToken` already refuses a
 * voided invoice, but that only stops the hosted URL being obtained — a client
 * who already has it can still pay at Confido, and the webhook then calls
 * `recordPayment`, which refuses a voided invoice and throws. The result is
 * money taken at the processor, nothing on our ledger, and a job retrying until
 * it exhausts.
 *
 * **Void only, deliberately.** `refunded` looks like the same case and is not:
 * `deriveStoredStatus` returns `void` unchanged forever, but derives `refunded`
 * from the ledger, so a later payment moves it back to `partial`. Confido has
 * no un-remove, so retiring a refunded invoice's link would permanently break a
 * payment the firm may still legitimately be owed.
 *
 * No-op when the invoice never had a link, which is most of them — links are
 * minted lazily on first checkout.
 *
 * **This cannot close the door on a partially-paid invoice.** Confido confirmed
 * that `removePaymentLink` is rejected once the link is referenced by other
 * records — "if the paylink has been paid or has associated transactions, the
 * delete will fail" (Aug 2026) — and an invoice with a payment against it is
 * exactly the one a firm is most likely to void. So the call below reliably
 * fails in that case and the URL stays live.
 *
 * That is survivable because it is not the only guard, and deliberately not the
 * last one: `invoiceByPaymentToken` refuses a voided invoice, and the webhook
 * path records a payment against a voided invoice on the finance trail instead
 * of retrying forever. See `PAYMENT_WEBHOOK_VOIDED_INVOICE_PAYMENT`.
 */
export const retirePaymentLink = async (
  organizationId: string,
  invoiceId: string,
): Promise<boolean> => {
  const { credential } = await confidoCredentialFor(organizationId);
  const client = getConfidoClient();

  const existing = await client.findPaymentLinkByExternalId(credential, invoiceId);
  if (!existing) return false;

  await client.removePaymentLink(credential, { id: existing.id });

  log.action(LogEvent.PAYMENT_LINK_RETIRED, {
    invoiceId,
    paymentLinkId: existing.id,
  });

  return true;
};
