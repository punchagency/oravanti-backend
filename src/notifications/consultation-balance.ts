import { and, asc, eq } from "drizzle-orm";
import { systemDb } from "../db/client";
import { consultations } from "../db/schema/consultations";
import { invoiceInstalments } from "../db/schema/invoice-instalments";
import { invoices } from "../db/schema/invoices";
import { leads } from "../db/schema/leads";
import { LogEvent } from "../lib/logging/events";
import { createModuleLogger } from "../lib/logging/log";
import {
  mintPaymentLink,
  paymentLinkFor,
} from "../modules/finance/payment-links.service";
import { num } from "../modules/finance/money";
import { getFirmTimezone } from "../modules/settings/consultation/consultation-settings.service";
import { formatWithZone } from "../utils/date";
import { cancelNotifications, notify } from "./notification.service";

const log = createModuleLogger("consultation-balance");

/**
 * The second instalment of a deposit, asked for after the consultation.
 *
 * Nothing asked for it before this. `partial_upfront` raises ONE invoice with
 * two dated slices — deliberately, so there is one number and one dunning track
 * — and the deposit half was emailed at booking while the balance simply became
 * due on the same invoice. The lead had to remember to revisit a link from an
 * email they received weeks earlier, and the only follow-up mechanism in the
 * system is a staff member manually pressing send.
 *
 * An ordinary `notifications` row with a `sendAt`, like the consultation
 * reminders: it inherits the ledger, the consent checks and the dedupe that the
 * hand-rolled consultation emails bypass. Requires `npm run worker` to deliver,
 * as everything through `notify()` does.
 */

const dedupePrefix = (consultationId: string) =>
  `consultation-balance-${consultationId}`;

/** Stable identity for "the balance notice for this consultation". */
const dedupeKey = (consultationId: string) => dedupePrefix(consultationId);

/**
 * Schedule (or reschedule) the balance notice.
 *
 * Cancels first, always — the same remove-then-add discipline the reminders
 * use, so a rescheduled consultation cannot end up with two notices and a
 * re-run cannot silently drop the only one.
 *
 * Safe to call on any consultation. Anything without a two-slice schedule, an
 * outstanding balance and a future due date ends up with its notice cancelled
 * and none created.
 */
export const scheduleConsultationBalanceNotice = async (
  organizationId: string,
  consultationId: string,
): Promise<void> => {
  await cancelConsultationBalanceNotice(organizationId, consultationId);

  const [consultation] = await systemDb
    .select()
    .from(consultations)
    .where(eq(consultations.id, consultationId))
    .limit(1);

  if (!consultation?.invoiceId) return;
  // Nothing is owed on a consultation the firm cancelled or the lead missed;
  // the no-show policy governs those and may have voided or refunded already.
  if (consultation.status === "cancelled" || consultation.status === "no_show")
    return;

  const [invoice] = await systemDb
    .select({
      status: invoices.status,
      invoiceNumber: invoices.invoiceNumber,
      balanceDue: invoices.balanceDue,
    })
    .from(invoices)
    .where(eq(invoices.id, consultation.invoiceId))
    .limit(1);

  if (!invoice || invoice.status === "void") return;
  if (num(invoice.balanceDue) <= 0) return;

  const rows = await systemDb
    .select({
      dueDate: invoiceInstalments.dueDate,
      amount: invoiceInstalments.amount,
    })
    .from(invoiceInstalments)
    .where(
      and(
        eq(invoiceInstalments.organizationId, organizationId),
        eq(invoiceInstalments.invoiceId, consultation.invoiceId),
      ),
    )
    .orderBy(asc(invoiceInstalments.sequence));

  // Only the deposit shape. A single-payment invoice has no balance half, and a
  // hand-built schedule of three or more is somebody's deliberate arrangement.
  if (rows.length !== 2) return;

  // Sent ON the due date rather than ahead of it: this is the first time the
  // client hears about the balance, so arriving early would be asking for money
  // before it is owed.
  const sendAt = new Date(`${rows[1]!.dueDate}T09:00:00Z`);
  if (sendAt.getTime() <= Date.now()) return;

  const [lead] = await systemDb
    .select({ timezone: leads.timezone })
    .from(leads)
    .where(eq(leads.id, consultation.leadId))
    .limit(1);

  if (!lead) return;

  // Minted now, not at send time: the worker renders a persisted context and
  // has no invoice in hand. The link is stable — `ensurePaymentLink` updates
  // the SAME Confido link in place as `amountDueNow` moves from the deposit to
  // the balance — so a token minted today still asks for the right figure.
  let payUrl: string | undefined;
  try {
    // The TTL has to cover the wait. The default is 30 days and the balance can
    // be set up to 90 out, so a link minted on the default would expire before
    // the email carrying it was ever delivered. A week's grace past the send.
    const ttlDays =
      Math.ceil((sendAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) + 7;
    const token = await mintPaymentLink(
      organizationId,
      consultation.invoiceId,
      ttlDays,
    );
    payUrl = paymentLinkFor(token);
  } catch (err) {
    // Worth sending without a link: the client still learns the balance is due
    // and can call the office, which beats silence.
    log.failure(LogEvent.CONSULTATION_BALANCE_LINK_FAILED, err, { consultationId });
  }

  const firmTz = await getFirmTimezone(organizationId);
  const tz = lead.timezone ?? firmTz;

  await notify({
    organizationId,
    event: "consultation_balance_due",
    recipients: [{ type: "lead", id: consultation.leadId }],
    context: {
      when: consultation.scheduledAt
        ? formatWithZone(consultation.scheduledAt, tz)
        : "",
      // Formatted here, in the same act that reads it. The worker renders jsonb
      // and has no locale to format a bare number against.
      amount: `$${num(rows[1]!.amount).toFixed(2)}`,
      invoiceNumber: invoice.invoiceNumber,
      ...(payUrl ? { payUrl } : {}),
    },
    sendAt,
    scenario: { leadId: consultation.leadId, consultationId },
    dedupeKey: dedupeKey(consultationId),
  });
};

/**
 * Cancel a pending balance notice.
 *
 * Called before rescheduling, and when a consultation is cancelled or marked a
 * no-show — a demand for the balance of a consultation the firm has just
 * refunded is worse than no demand.
 */
export const cancelConsultationBalanceNotice = async (
  organizationId: string,
  consultationId: string,
): Promise<number> =>
  cancelNotifications(organizationId, dedupePrefix(consultationId));
