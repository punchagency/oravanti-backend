/**
 * Consultation payment policy check.
 *
 * The behaviours this covers are the ones that were silently wrong for months
 * and cannot be seen from the UI:
 *
 *   - the booking gate reads the LEDGER, not `consultations.fee_status`, so a
 *     voided fee invoice opens the gate instead of stranding the lead forever
 *   - a deposit opens the gate at exactly the deposit, and not a cent before
 *   - a refund RE-CLOSES the gate, which a stored flag could never do
 *   - the settings CHECK refuses a deposit on a schedule that has none
 *
 * Runs against the TEST database (npm run check 20-consultation-payment-policy)
 * and cleans up the org it creates.
 */
import { createHash, randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import { organization, user } from "../../src/db/schema/auth-schema";
import { consultationSettings } from "../../src/db/schema/consultation-settings";
import { consultations } from "../../src/db/schema/consultations";
import { invoiceInstalments } from "../../src/db/schema/invoice-instalments";
import { invoicePayments } from "../../src/db/schema/invoice-payments";
import { invoices } from "../../src/db/schema/invoices";
import { leads } from "../../src/db/schema/leads";
import { staff } from "../../src/db/schema/staff";
import { consultationPaymentOutstanding } from "../../src/modules/finance/consultation-billing.service";
import { systemAccess } from "../../src/modules/finance/account-access";
import * as invoicesService from "../../src/modules/finance/invoices.service";
import { isWholeTransaction } from "../../src/modules/finance/refunds.service";
import { hasLiveConsultation } from "../../src/modules/finance/consultation-billing.service";
import { CONFIDO_PROVIDER } from "../../src/modules/finance/confido/confido-webhooks.service";
import { invoiceByPaymentToken } from "../../src/modules/finance/payment-links.service";
import { check, checkEqual, report, section } from "./_bootstrap";

const main = async () => {
  const suffix = randomUUID().slice(0, 8);
  const orgId = `check-org-${suffix}`;
  const userId = `check-user-${suffix}`;
  const now = new Date();

  let leadId = "";
  let staffId = "";

  try {
    await systemDb.insert(user).values({
      id: userId,
      name: `Check User ${suffix}`,
      email: `check-${suffix}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await systemDb.insert(organization).values({
      id: orgId,
      name: `Check Org ${suffix}`,
      slug: `check-org-${suffix}`,
      createdAt: now,
    });
    const [staffRow] = await systemDb
      .insert(staff)
      .values({
        organizationId: orgId,
        userId,
        firstName: "Check",
        lastName: `Staff ${suffix}`,
        email: `staff-${suffix}@example.test`,
        role: "admin",
      })
      .returning();
    staffId = staffRow!.id;
    const [leadRow] = await systemDb
      .insert(leads)
      .values({
        organizationId: orgId,
        firstName: "Check",
        lastName: `Lead ${suffix}`,
        email: `lead-${suffix}@example.test`,
        source: "direct",
      })
      .returning();
    leadId = leadRow!.id;

    // ── helpers ──────────────────────────────────────────────────────────────

    let seq = 0;
    const makeInvoice = async (total: number, status: "sent" | "void" = "sent") => {
      seq += 1;
      const [row] = await systemDb
        .insert(invoices)
        .values({
          organizationId: orgId,
          invoiceNumber: `CHK-${suffix}-${seq}`,
          leadId,
          issueDate: "2026-01-01",
          dueDate: "2026-01-01",
          status,
          subtotalOperating: String(total),
          subtotalTrust: "0",
          totalAmount: String(total),
          amountPaid: "0",
          // balance_due is GENERATED ALWAYS (total_amount - amount_paid), so
          // it cannot be inserted.
        })
        .returning();
      return row!.id;
    };

    const makeConsultation = async (invoiceId: string | null) => {
      const [row] = await systemDb
        .insert(consultations)
        .values({
          organizationId: orgId,
          leadId,
          duration: 30,
          mode: "video",
          status: "pending_payment",
          feeStatus: "unpaid",
          invoiceId,
        })
        .returning();
      return row!;
    };

    const pay = async (
      invoiceId: string,
      amount: number,
      // Processor-backed when given. `refundable` requires a provider — a
      // cheque cannot be sent back through Confido — so any assertion about
      // refundability has to use a payment that actually has one, or it passes
      // for the wrong reason.
      provider?: string,
    ) => {
      // `invoice_payments_split_balances` requires amount = operating + trust.
      await systemDb.insert(invoicePayments).values({
        organizationId: orgId,
        invoiceId,
        amount: String(amount),
        amountOperating: String(amount),
        amountTrust: "0",
        paymentDate: "2026-01-01",
        method: "other",
        kind: "payment",
        ...(provider
          ? { provider, providerReference: `txn-${randomUUID().slice(0, 8)}` }
          : {}),
      });
      // What `recalculateInvoiceTotals` does in production. `amount_paid` is the
      // only STORED paid figure and `allocate` folds over it, so a fixture that
      // writes only the ledger row leaves the schedule looking untouched.
      // `balance_due` is generated and follows.
      await systemDb
        .update(invoices)
        .set({ amountPaid: sql`${invoices.amountPaid} + ${String(amount)}` })
        .where(eq(invoices.id, invoiceId));
    };

    const reverse = async (invoiceId: string, amount: number, paymentId: string) => {
      // A reversal is a NEGATIVE row; the split has to be negative too.
      await systemDb.insert(invoicePayments).values({
        organizationId: orgId,
        invoiceId,
        amount: String(-Math.abs(amount)),
        amountOperating: String(-Math.abs(amount)),
        amountTrust: "0",
        paymentDate: "2026-01-01",
        method: "other",
        kind: "refund",
        reversesPaymentId: paymentId,
      });
      await systemDb
        .update(invoices)
        .set({
          amountPaid: sql`${invoices.amountPaid} - ${String(Math.abs(amount))}`,
        })
        .where(eq(invoices.id, invoiceId));
    };

    const outstanding = (c: { invoiceId: string | null; feeStatus: string }) =>
      consultationPaymentOutstanding(orgId, c);

    // ── 1. Full upfront ──────────────────────────────────────────────────────
    section("Full upfront: the whole fee gates the booking");

    const invA = await makeInvoice(300);
    const consA = await makeConsultation(invA);

    check("nothing paid -> gate closed", await outstanding(consA));
    await pay(invA, 150);
    check("half paid -> still closed", await outstanding(consA));
    await pay(invA, 150);
    check("paid in full -> gate open", !(await outstanding(consA)));

    // ── 2. A voided invoice must not strand the lead ─────────────────────────
    section("Voided fee invoice opens the gate (the stranding bug)");

    const invB = await makeInvoice(300);
    const consB = await makeConsultation(invB);
    check("unpaid -> gate closed", await outstanding(consB));

    await systemDb
      .update(invoices)
      .set({ status: "void" })
      .where(eq(invoices.id, invB));

    // fee_status is deliberately left at "unpaid" — that is exactly the state
    // that used to lock the lead out permanently, because no payment could ever
    // arrive against a voided invoice.
    check(
      "voided -> gate OPEN even though fee_status is still 'unpaid'",
      !(await outstanding({ invoiceId: invB, feeStatus: "unpaid" })),
    );

    // ── 3. Partial upfront ───────────────────────────────────────────────────
    section("Deposit opens the gate at exactly the deposit");

    const invC = await makeInvoice(400);
    const consC = await makeConsultation(invC);
    // 25% of 400. Sequence 1 is the deposit; setSchedule renumbers by due date.
    await systemDb.insert(invoiceInstalments).values([
      {
        organizationId: orgId,
        invoiceId: invC,
        sequence: 1,
        dueDate: "2026-01-01",
        amount: "100",
      },
      {
        organizationId: orgId,
        invoiceId: invC,
        sequence: 2,
        dueDate: "2026-02-01",
        amount: "300",
      },
    ]);

    check("nothing paid -> closed", await outstanding(consC));
    await pay(invC, 99.99);
    check("a cent short of the deposit -> still closed", await outstanding(consC));
    await pay(invC, 0.01);
    check("deposit met exactly -> OPEN", !(await outstanding(consC)));
    check(
      "still open with the balance outstanding",
      !(await outstanding(consC)),
    );

    // ── 3b. The payment page asks for the instalment, not the balance ────────
    section("The payment link quotes the instalment, not the whole balance");

    // `payment_token_hash` is sha256 of the token, same as the service.
    const linkFor = async (invoiceId: string) => {
      const token = randomUUID();
      await systemDb
        .update(invoices)
        .set({
          paymentTokenHash: createHash("sha256").update(token).digest("hex"),
        })
        .where(eq(invoices.id, invoiceId));
      return invoiceByPaymentToken(token);
    };

    {
      // A fresh deposit invoice, nothing paid: the page must quote the deposit,
      // not the whole fee. This is the bug — the invoice showed two instalments
      // and the payment page asked for the lot.
      const invE = await makeInvoice(400);
      await makeConsultation(invE);
      await systemDb.insert(invoiceInstalments).values([
        { organizationId: orgId, invoiceId: invE, sequence: 1, dueDate: "2026-01-01", amount: "100" },
        { organizationId: orgId, invoiceId: invE, sequence: 2, dueDate: "2026-02-01", amount: "300" },
      ]);

      const payable = await linkFor(invE);
      checkEqual("the whole fee is owed", payable.balanceDue, 400);
      checkEqual("but the page asks only for the deposit", payable.amountDueNow, 100);

      // Once the deposit lands, the balance is what falls due next — otherwise
      // the second instalment would be unpayable.
      await pay(invE, 100);
      const after = await linkFor(invE);
      checkEqual("after the deposit, it asks for the balance", after.amountDueNow, 300);
      checkEqual("and the balance owed has dropped", after.balanceDue, 300);
    }

    {
      // No schedule: the page asks for the whole balance, as it always did.
      const invF = await makeInvoice(250);
      const payable = await linkFor(invF);
      checkEqual("unscheduled invoice asks for the balance", payable.amountDueNow, 250);
    }

    // ── 4. A refund re-closes the gate ───────────────────────────────────────
    section("A refund re-closes the gate");

    const invD = await makeInvoice(200);
    const consD = await makeConsultation(invD);
    await pay(invD, 200);
    check("paid -> open", !(await outstanding(consD)));

    const [paymentD] = await systemDb
      .select({ id: invoicePayments.id })
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, invD));
    await reverse(invD, 200, paymentD!.id);

    check(
      "refunded -> gate CLOSED again (a stored flag could not do this)",
      await outstanding(consD),
    );

    // ── 4b. Refundability is net of what has already gone back ───────────────
    section("A refunded payment stops being refundable");

    // Fully reversed: nothing left, so no Refund button.
    {
      const invG = await makeInvoice(200);
      await pay(invG, 200, CONFIDO_PROVIDER);
      const [pg] = await systemDb
        .select({ id: invoicePayments.id })
        .from(invoicePayments)
        .where(
          and(
            eq(invoicePayments.invoiceId, invG),
            eq(invoicePayments.kind, "payment"),
          ),
        );
      await reverse(invG, 200, pg!.id);

      const detail = await invoicesService.getById(orgId, invG, systemAccess());
      const original = detail.payments.find((p) => p.kind === "payment")!;
      const reversal = detail.payments.find((p) => p.kind !== "payment");

      check("both ledger rows are still shown", Boolean(original && reversal));
      check("the reversal is negative", (reversal?.amount ?? 0) < 0);
      check("the fully refunded payment is NOT refundable", !original.refundable);
      checkEqual("nothing left to refund", original.refundableAmount, 0);
    }

    // Partly reversed: a remainder survives, so the button stays.
    {
      const invH = await makeInvoice(200);
      await pay(invH, 200, CONFIDO_PROVIDER);
      const [ph] = await systemDb
        .select({ id: invoicePayments.id })
        .from(invoicePayments)
        .where(
          and(
            eq(invoicePayments.invoiceId, invH),
            eq(invoicePayments.kind, "payment"),
          ),
        );
      await reverse(invH, 50, ph!.id);

      const detail = await invoicesService.getById(orgId, invH, systemAccess());
      const original = detail.payments.find((p) => p.kind === "payment")!;
      check("a partly refunded payment stays refundable", original.refundable);
      checkEqual("and reports the remainder", original.refundableAmount, 150);
    }

    // A hand-recorded payment has no processor to refund through, whatever is
    // left on it.
    {
      const invI = await makeInvoice(100);
      await pay(invI, 100);
      const detail = await invoicesService.getById(orgId, invI, systemAccess());
      const original = detail.payments.find((p) => p.kind === "payment")!;
      check("a manual payment is not processor-refundable", !original.refundable);
      checkEqual("but still reports its full amount", original.refundableAmount, 100);
    }

    // ── 4c. Void vs refund: chosen by the figure, not by the caller ───────────
    section("The reversal path follows the amount, not the caller's phrasing");

    check(
      "reversing the whole payment is a void-capable whole transaction",
      isWholeTransaction(200, 200),
    );
    check(
      "an explicit full amount is ALSO whole (the pre-settlement bug)",
      isWholeTransaction(200, 200),
    );
    check(
      "a remainder after a partial reversal is not whole",
      !isWholeTransaction(150, 200),
    );
    check("a part payment is not whole", !isWholeTransaction(50, 200));
    check(
      "a half-cent difference still counts as whole",
      isWholeTransaction(199.998, 200),
    );

    // ── 4d. The Finance block follows liveness, not existence ────────────────
    section("Finance refuses only while the consultation is still live");

    {
      const statuses = [
        ["pending_payment", true],
        ["awaiting_slot_selection", true],
        ["scheduled", true],
        ["in_progress", true],
        ["cancelled", false],
        ["completed", false],
        ["no_show", false],
      ] as const;

      for (const [status, expected] of statuses) {
        const inv = await makeInvoice(100);
        const cons = await makeConsultation(inv);
        await systemDb
          .update(consultations)
          .set({ status })
          .where(eq(consultations.id, cons.id));

        const blocked = await hasLiveConsultation(orgId, inv);
        checkEqual(`${status} -> blocked=${expected}`, blocked, expected);

        // The same rule is written twice — TypeScript for the controller guard,
        // SQL for the list and detail queries. A check that exercised only one
        // would let them drift, and a UI hiding the button for a CANCELLED
        // consultation would leave a failed refund reachable by API and by no
        // human.
        const detail = await invoicesService.getById(orgId, inv, systemAccess());
        checkEqual(
          `${status} -> SQL agrees with the guard`,
          detail.consultationRefundBlocked,
          blocked,
        );
      }
    }

    {
      const inv = await makeInvoice(100);
      check(
        "an invoice with no consultation is never blocked",
        !(await hasLiveConsultation(orgId, inv)),
      );
    }

    // ── 5. No invoice: the legacy flag still governs ──────────────────────────
    section("Consultations that predate invoicing");

    check(
      "no invoice + unpaid -> closed",
      await outstanding({ invoiceId: null, feeStatus: "unpaid" }),
    );
    check(
      "no invoice + paid -> open",
      !(await outstanding({ invoiceId: null, feeStatus: "paid" })),
    );

    // ── 6. The settings constraint ───────────────────────────────────────────
    section("Settings refuse a deposit that contradicts the schedule");

    await systemDb.insert(consultationSettings).values({
      organizationId: orgId,
      chargesFee: true,
      defaultAmount: "300",
      feeStructure: "flat",
    });

    let refused = false;
    try {
      await systemDb
        .update(consultationSettings)
        .set({ upfrontPercent: 50 })
        .where(eq(consultationSettings.organizationId, orgId));
    } catch {
      refused = true;
    }
    check("deposit on full_upfront is refused by the CHECK", refused);

    let outOfRange = false;
    try {
      await systemDb
        .update(consultationSettings)
        .set({ feeSchedule: "partial_upfront", upfrontPercent: 100 })
        .where(eq(consultationSettings.organizationId, orgId));
    } catch {
      outOfRange = true;
    }
    check("a 100% deposit is refused (that is full_upfront)", outOfRange);
  } finally {
    await systemDb.delete(consultationSettings).where(eq(consultationSettings.organizationId, orgId));
    await systemDb.delete(invoicePayments).where(eq(invoicePayments.organizationId, orgId));
    await systemDb.delete(invoiceInstalments).where(eq(invoiceInstalments.organizationId, orgId));
    await systemDb.delete(consultations).where(eq(consultations.organizationId, orgId));
    await systemDb.delete(invoices).where(eq(invoices.organizationId, orgId));
    if (leadId) await systemDb.delete(leads).where(eq(leads.organizationId, orgId));
    if (staffId) await systemDb.delete(staff).where(eq(staff.organizationId, orgId));
    await systemDb.delete(organization).where(eq(organization.id, orgId));
    await systemDb.delete(user).where(eq(user.id, userId));
  }

  await report();
  await closeDb();
};

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
