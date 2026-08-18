import { createHash, randomBytes } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { env } from "../../config/env";
import { db, systemDb } from "../../db/client";
import { invoicePayments } from "../../db/schema/invoice-payments";
import { invoices } from "../../db/schema/invoices";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { onClient, onLead, partyEmail, partyName } from "./party";
import { clients } from "../../db/schema/clients";
import { leads } from "../../db/schema/leads";
import { num } from "./money";
import { paymentsEnabledFor } from "./confido/payments-enabled";
import { getConfidoClient } from "./confido/confido.client";
import { confidoCredentialFor } from "../settings/payments/payment-settings.service";

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
  dueDate: string;
  status: string;
  /** False while this firm cannot take money — the page says so rather than lying. */
  paymentsEnabled: boolean;
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
 * expired, and states where paying makes no sense. A voided or fully paid
 * invoice is refused rather than silently accepting money against it.
 */
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

  if (!row) throw new NotFoundError("Payment link not found");
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new BadRequestError("This payment link has expired");
  }
  if (row.status === "void") {
    throw new BadRequestError("This invoice has been cancelled");
  }
  if (row.status === "draft") {
    throw new BadRequestError("This invoice is not ready for payment");
  }
  if (num(row.balanceDue) <= 0) {
    throw new BadRequestError("This invoice has already been paid in full");
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
    dueDate: row.dueDate,
    status: row.status,
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

  const existing = await client.findPaymentLinkByExternalId(
    credential,
    invoice.invoiceId,
  );
  if (existing) return existing;

  const payer = await ensurePayer(credential, firmId, invoice);
  const outstanding = await outstandingBySide(
    invoice.organizationId,
    invoice.invoiceId,
  );

  return client.addPaymentLink(credential, {
    clientId: payer.id,
    externalId: invoice.invoiceId,
    // Cents, and only the sides that are actually owed — a zero leg would ask
    // Confido to route money to an account this invoice has no claim on.
    ...(outstanding.trust > 0
      ? { trust: Math.round(outstanding.trust * 100) }
      : {}),
    ...(outstanding.operating > 0
      ? { operating: Math.round(outstanding.operating * 100) }
      : {}),
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
