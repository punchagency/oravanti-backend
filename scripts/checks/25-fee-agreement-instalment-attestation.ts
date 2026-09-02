/**
 * Attesting to a payment records the payment, not the plan.
 *
 * `settleByAttestation` recorded `invoice.balanceDue` — the whole outstanding
 * amount — with no notion of a schedule. So a firm marking the first instalment
 * of six received booked all six: the invoice went to paid, every future
 * instalment derived as settled, and the reminders that would have chased the
 * remaining five went quiet. The money was never collected and nothing said so.
 *
 * This asserts the three things that were wrong:
 *
 *   - one instalment records one instalment's worth, not the balance;
 *   - the rest stay outstanding, so the schedule still has something to chase;
 *   - the case-opening gate still opens on the first instalment, which is what
 *     it has always promised and what made the bug survivable in the first
 *     place — nobody noticed, because the case opened either way.
 *
 * Plus the arithmetic that has to hold for a partial attestation to be safe:
 * repeated attestations walk the schedule rather than double-booking, and no
 * count can drive the invoice into credit.
 *
 * Runs against the TEST database
 * (npm run check 25-fee-agreement-instalment-attestation).
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import { member, organization, user } from "../../src/db/schema/auth-schema";
import { auditEvents } from "../../src/db/schema/audit-events";
import { consultations } from "../../src/db/schema/consultations";
import { feeAgreementSettings } from "../../src/db/schema/fee-agreement-settings";
import { feeAgreements } from "../../src/db/schema/fee-agreements";
import { invoiceDeliveries } from "../../src/db/schema/invoice-deliveries";
import { invoiceInstalments } from "../../src/db/schema/invoice-instalments";
import { invoiceLineItems, invoices } from "../../src/db/schema/invoices";
import { invoiceNumberSequences } from "../../src/db/schema/invoice-number-sequences";
import { invoicePayments } from "../../src/db/schema/invoice-payments";
import { leads } from "../../src/db/schema/leads";
import { notifications } from "../../src/db/schema/notifications";
import { practiceAreaCaseTypes } from "../../src/db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../src/db/schema/practice-area-subcategories";
import { practiceAreas } from "../../src/db/schema/practice-areas";
import { staff } from "../../src/db/schema/staff";
import { allocatedInstalments } from "../../src/modules/finance/instalments.service";
import { num } from "../../src/modules/finance/money";
import {
  check,
  checkEqual,
  report,
  section,
  silenceEmail,
  withOrgContext,
} from "./_bootstrap";

const main = async () => {
  silenceEmail();

  const suffix = randomUUID().slice(0, 8);
  const orgId = `check-org-${suffix}`;
  const userId = `check-user-${suffix}`;
  const now = new Date();
  const createdAreas: string[] = [];
  const createdSubs: string[] = [];
  const createdTypes: string[] = [];
  let staffId: string;

  try {
    await systemDb.insert(user).values({
      id: userId,
      name: "Check Owner",
      email: `${userId}@example.test`,
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
    await systemDb.insert(member).values({
      id: `m-${suffix}`,
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: now,
    });
    const [staffRow] = await systemDb
      .insert(staff)
      .values({
        organizationId: orgId,
        userId,
        firstName: "Olive",
        lastName: `Owner ${suffix}`,
        orgEmail: `owner-${suffix}@example.test`,
        role: "owner",
      })
      .returning();
    staffId = staffRow!.id;

    // Counter-signing off: this check is about money, and a second signature
    // would only add a step between here and the invoice.
    await systemDb
      .insert(feeAgreementSettings)
      .values({ organizationId: orgId, requiresFirmSignature: false });

    const [area] = await systemDb
      .insert(practiceAreas)
      .values({ name: `Check Area ${suffix}` })
      .returning();
    createdAreas.push(area!.id);
    const [sub] = await systemDb
      .insert(practiceAreaSubcategories)
      .values({ practiceAreaId: area!.id, code: `sub-${suffix}`, name: "Sub" })
      .returning();
    createdSubs.push(sub!.id);
    const [caseType] = await systemDb
      .insert(practiceAreaCaseTypes)
      .values({
        subcategoryId: sub!.id,
        code: `type-${suffix}`,
        name: `Matter ${suffix}`,
        caseNumberPrefix: "CHK",
        jurisdiction: "federal",
      })
      .returning();
    createdTypes.push(caseType!.id);

    const [lead] = await systemDb
      .insert(leads)
      .values({
        organizationId: orgId,
        firstName: "Lee",
        lastName: `Lead ${suffix}`,
        email: `lead-${suffix}@example.test`,
        source: "direct",
        practiceAreaId: area!.id,
        caseTypeId: caseType!.id,
      })
      .returning();
    await systemDb.insert(consultations).values({
      organizationId: orgId,
      leadId: lead!.id,
      duration: 60,
      mode: "video",
      status: "completed",
    });

    const { LeadsService } = await import(
      "../../src/modules/leads/leads.service"
    );
    const svc = new LeadsService();

    // $6,000 over four monthly instalments of $1,500.
    const generated = await withOrgContext(orgId, userId, () =>
      svc.generateFeeAgreement(
        lead!.id,
        orgId,
        {
          attorneyFee: { type: "flat", flatRate: 6000 },
          generatedFrom: "manual",
          paymentPlan: "installments",
          installmentSchedule: {
            monthlyAmount: 1500,
            numberOfPayments: 4,
            firstPaymentDate: "2026-10-01",
          },
          // Invoiced but not emailed, so the check does not depend on a mailer.
          paymentTiming: "invoice_after",
        },
        staffId,
      ),
    );
    const agreementId = generated.agreement.id;

    await withOrgContext(orgId, userId, () =>
      svc.sendFeeAgreement(agreementId, orgId, staffId),
    );
    // Marking it received raises and issues the invoice.
    await withOrgContext(orgId, userId, () =>
      svc.markFeeAgreementReceived(agreementId, orgId, staffId),
    );

    const invoiceIdOf = async () => {
      const [row] = await systemDb
        .select({ invoiceId: feeAgreements.invoiceId })
        .from(feeAgreements)
        .where(eq(feeAgreements.id, agreementId))
        .limit(1);
      return row!.invoiceId!;
    };
    const invoiceId = await invoiceIdOf();

    const invoiceRow = async () => {
      const [row] = await systemDb
        .select({
          amountPaid: invoices.amountPaid,
          balanceDue: invoices.balanceDue,
          totalAmount: invoices.totalAmount,
          status: invoices.status,
        })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1);
      return row!;
    };

    section("The invoice is raised on a real schedule");
    const schedule = await allocatedInstalments(orgId, invoiceId);
    checkEqual("four instalments were written", schedule.length, 4);
    const total = num((await invoiceRow()).totalAmount);
    check("they sum to the invoice total", Math.abs(
      schedule.reduce((s, r) => s + r.amount, 0) - total,
    ) < 0.01);

    section("One instalment records one instalment");
    await withOrgContext(orgId, userId, () =>
      svc.markFeeAgreementPaymentReceived(agreementId, orgId, staffId, 1),
    );

    let inv = await invoiceRow();
    const first = schedule[0]!.amount;
    checkEqual("only the first instalment is paid", num(inv.amountPaid), first);
    check(
      "the rest is still owed",
      Math.abs(num(inv.balanceDue) - (total - first)) < 0.01,
    );
    check("so the invoice is not settled", inv.status !== "paid");

    const afterOne = await allocatedInstalments(orgId, invoiceId);
    checkEqual("instalment 1 reads as paid", afterOne[0]!.state, "paid");
    checkEqual("instalment 2 is still due", afterOne[1]!.state, "due");
    checkEqual(
      "three remain outstanding to chase",
      afterOne.filter((r) => r.outstanding > 0).length,
      3,
    );

    section("The case-opening gate still opens on the first instalment");
    const [afterGate] = await systemDb
      .select({ pipelineStage: leads.pipelineStage })
      .from(leads)
      .where(eq(leads.id, lead!.id))
      .limit(1);
    checkEqual(
      "the lead advanced on one instalment, as it always has",
      afterGate!.pipelineStage,
      "case_opening",
    );

    section("Repeat attestations walk the schedule");
    await withOrgContext(orgId, userId, () =>
      svc.markFeeAgreementPaymentReceived(agreementId, orgId, staffId, 2),
    );
    inv = await invoiceRow();
    const three = schedule.slice(0, 3).reduce((s, r) => s + r.amount, 0);
    check(
      "two more instalments take the total to three, not to the balance",
      Math.abs(num(inv.amountPaid) - three) < 0.01,
    );

    section("Nothing can over-pay the invoice");
    let refused = false;
    try {
      await withOrgContext(orgId, userId, () =>
        svc.markFeeAgreementPaymentReceived(agreementId, orgId, staffId, 9),
      );
    } catch {
      refused = true;
    }
    check("a count beyond what is outstanding is refused", refused);

    inv = await invoiceRow();
    check(
      "and the invoice never goes into credit",
      num(inv.balanceDue) >= -0.005,
    );

    // The last one settles it, which is the only path to `paid`.
    await withOrgContext(orgId, userId, () =>
      svc.markFeeAgreementPaymentReceived(agreementId, orgId, staffId, 1),
    );
    inv = await invoiceRow();
    check("the final instalment settles the invoice", num(inv.balanceDue) <= 0.005);
    checkEqual(
      "every instalment now reads as paid",
      (await allocatedInstalments(orgId, invoiceId)).filter(
        (r) => r.outstanding > 0,
      ).length,
      0,
    );
  } finally {
    await systemDb.delete(auditEvents).where(eq(auditEvents.organizationId, orgId));
    await systemDb.delete(invoiceDeliveries).where(eq(invoiceDeliveries.organizationId, orgId));
    await systemDb.delete(invoicePayments).where(eq(invoicePayments.organizationId, orgId));
    await systemDb.delete(invoiceInstalments).where(eq(invoiceInstalments.organizationId, orgId));
    await systemDb.delete(invoiceLineItems).where(eq(invoiceLineItems.organizationId, orgId));
    await systemDb.delete(invoices).where(eq(invoices.organizationId, orgId));
    await systemDb
      .delete(invoiceNumberSequences)
      .where(eq(invoiceNumberSequences.organizationId, orgId));
    await systemDb.delete(feeAgreements).where(eq(feeAgreements.organizationId, orgId));
    await systemDb
      .delete(feeAgreementSettings)
      .where(eq(feeAgreementSettings.organizationId, orgId));
    await systemDb.delete(consultations).where(eq(consultations.organizationId, orgId));
    await systemDb.delete(leads).where(eq(leads.organizationId, orgId));
    await systemDb.delete(notifications).where(eq(notifications.organizationId, orgId));
    await systemDb.delete(staff).where(eq(staff.organizationId, orgId));
    await systemDb.delete(member).where(eq(member.organizationId, orgId));
    await systemDb.delete(organization).where(eq(organization.id, orgId));
    await systemDb.delete(user).where(eq(user.id, userId));
    for (const id of createdTypes)
      await systemDb.delete(practiceAreaCaseTypes).where(eq(practiceAreaCaseTypes.id, id));
    for (const id of createdSubs)
      await systemDb.delete(practiceAreaSubcategories).where(eq(practiceAreaSubcategories.id, id));
    for (const id of createdAreas)
      await systemDb.delete(practiceAreas).where(eq(practiceAreas.id, id));
  }

  await report();
  await closeDb();
};

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
