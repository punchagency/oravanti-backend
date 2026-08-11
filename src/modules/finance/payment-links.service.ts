import { createHash, randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { env } from "../../config/env";
import { db } from "../../db/client";
import { invoices } from "../../db/schema/invoices";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { onClient, onLead, partyEmail, partyName } from "./party";
import { clients } from "../../db/schema/clients";
import { leads } from "../../db/schema/leads";
import { num } from "./money";
import { getPaymentProvider, isPaymentProviderConfigured } from "./payment.provider";

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
  /** False while no provider is configured — the page says so rather than lying. */
  paymentsEnabled: boolean;
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
    paymentsEnabled: isPaymentProviderConfigured(),
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

  if (!isPaymentProviderConfigured()) {
    throw new BadRequestError(
      "Online payment is not available yet. Please contact the firm to arrange payment.",
    );
  }

  const provider = getPaymentProvider();
  const session = await provider.createCheckoutSession({
    invoiceId: invoice.invoiceId,
    organizationId: invoice.organizationId,
    invoiceNumber: invoice.invoiceNumber,
    // Minor units: handing a float to a payment API is how rounding disputes
    // start.
    amountCents: Math.round(invoice.balanceDue * 100),
    currency: "usd",
    description: `Invoice ${invoice.invoiceNumber}`,
    payerEmail: invoice.payerEmail,
    returnUrl: paymentLinkFor(token),
  });

  return { url: session.url, reference: session.reference };
};
