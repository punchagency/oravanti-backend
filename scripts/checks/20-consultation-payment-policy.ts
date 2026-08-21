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
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
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
import { check, report, section } from "./_bootstrap";

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

    const pay = async (invoiceId: string, amount: number) => {
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
      });
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
