/**
 * A payment is applied the way the signed agreement says it is.
 *
 * A fee agreement lets the firm choose how payments divide between attorney
 * fees and costs, and prints that choice into the document the client signs —
 * "Payments received are applied first to attorney fees, then to costs and
 * disbursements." The ledger ignored it. `paymentAllocation` was written at
 * generation, read only to render prose, and every payment was split by
 * `trustFirstSplit` regardless. The firm promised one order and did another.
 *
 * What makes this worth asserting rather than eyeballing is that the two axes
 * do not line up. The promise is fees-vs-costs; the ledger stores
 * operating-vs-trust. A government filing fee is a *cost* held in *trust*,
 * while other disbursements are *costs* landing in *operating* beside the
 * firm's own fee. Only a case with all three can tell the orders apart.
 *
 * So every invoice here is $1,000 attorney fee (operating) + $200 other costs
 * (operating) + $500 government fees (trust), and every assertion turns on a
 * $600 payment — less than the fee, less than the costs, and more than the
 * trust leg alone, so fees-first, costs-first and trust-first each give a
 * visibly different answer.
 *
 * Runs against the TEST database
 * (npm run check 26-fee-agreement-payment-application).
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
import { systemAccess } from "../../src/modules/finance/account-access";
import { num } from "../../src/modules/finance/money";
import * as paymentsService from "../../src/modules/finance/payments.service";
import {
  check,
  checkEqual,
  report,
  section,
  silenceEmail,
  withOrgContext,
} from "./_bootstrap";

type Allocation = {
  order: "fees_first" | "costs_first" | "custom";
  customFeePercent?: number;
} | null;

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
  let areaId: string;
  let caseTypeId: string;

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
    areaId = area!.id;
    createdAreas.push(areaId);
    const [sub] = await systemDb
      .insert(practiceAreaSubcategories)
      .values({ practiceAreaId: areaId, code: `sub-${suffix}`, name: "Sub" })
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
    caseTypeId = caseType!.id;
    createdTypes.push(caseTypeId);

    const { LeadsService } = await import(
      "../../src/modules/leads/leads.service"
    );
    const svc = new LeadsService();

    /**
     * A signed agreement with one of each line, and its invoice raised.
     * $1,000 fee (operating) + $200 other costs (operating) + $500 government
     * fees (trust).
     */
    const seedInvoice = async (allocation: Allocation) => {
      const [lead] = await systemDb
        .insert(leads)
        .values({
          organizationId: orgId,
          firstName: "Lee",
          lastName: `Lead ${randomUUID().slice(0, 6)}`,
          email: `lead-${randomUUID().slice(0, 6)}@example.test`,
          source: "direct",
          practiceAreaId: areaId,
          caseTypeId,
        })
        .returning();
      await systemDb.insert(consultations).values({
        organizationId: orgId,
        leadId: lead!.id,
        duration: 60,
        mode: "video",
        status: "completed",
      });

      const generated = await withOrgContext(orgId, userId, () =>
        svc.generateFeeAgreement(
          lead!.id,
          orgId,
          {
            attorneyFee: { type: "flat", flatRate: 1000 },
            generatedFrom: "manual",
            governmentFees: [{ name: "Filing fee", amount: 500 }],
            otherCosts: [{ name: "Courier", amount: 200 }],
            paymentPlan: "pay_in_full",
            // Invoiced but not emailed, so nothing here needs a mailer.
            paymentTiming: "invoice_after",
            ...(allocation ? { paymentAllocation: allocation } : {}),
          },
          staffId,
        ),
      );
      const agreementId = generated.agreement.id;
      await withOrgContext(orgId, userId, () =>
        svc.sendFeeAgreement(agreementId, orgId, staffId),
      );
      await withOrgContext(orgId, userId, () =>
        svc.markFeeAgreementReceived(agreementId, orgId, staffId),
      );

      const [row] = await systemDb
        .select({ invoiceId: feeAgreements.invoiceId })
        .from(feeAgreements)
        .where(eq(feeAgreements.id, agreementId))
        .limit(1);
      return row!.invoiceId!;
    };

    const paidBySide = async (invoiceId: string) => {
      const rows = await systemDb
        .select({
          operating: invoicePayments.amountOperating,
          trust: invoicePayments.amountTrust,
        })
        .from(invoicePayments)
        .where(eq(invoicePayments.invoiceId, invoiceId));
      return rows.reduce(
        (acc, r) => ({
          operating: acc.operating + num(r.operating),
          trust: acc.trust + num(r.trust),
        }),
        { operating: 0, trust: 0 },
      );
    };

    const pay = (invoiceId: string, amount: number) =>
      withOrgContext(orgId, userId, () =>
        paymentsService.recordPayment(orgId, invoiceId, staffId, systemAccess(), {
          amount,
          paymentDate: new Date().toISOString().slice(0, 10),
          method: "bank_transfer",
        }),
      );

    // ── The invoice the whole check turns on ────────────────────────────────
    section("The invoice carries the fee/cost axis the clause needs");

    const feesFirstInvoice = await seedInvoice({ order: "fees_first" });
    const lines = await systemDb
      .select({
        amount: invoiceLineItems.amount,
        account: invoiceLineItems.account,
        category: invoiceLineItems.category,
      })
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, feesFirstInvoice));

    checkEqual("three lines were raised", lines.length, 3);
    check(
      "every line is classified, or the whole invoice falls back",
      lines.every((l) => l.category !== null),
    );
    checkEqual(
      "the attorney fee is a fee in operating",
      lines.filter((l) => l.category === "fee" && l.account === "operating").length,
      1,
    );
    checkEqual(
      "the filing fee is a cost in trust",
      lines.filter((l) => l.category === "cost" && l.account === "trust_iolta").length,
      1,
    );
    checkEqual(
      "the courier charge is a cost in operating — the case that distinguishes the two axes",
      lines.filter((l) => l.category === "cost" && l.account === "operating").length,
      1,
    );

    const [snapshot] = await systemDb
      .select({ order: invoices.paymentApplicationOrder })
      .from(invoices)
      .where(eq(invoices.id, feesFirstInvoice))
      .limit(1);
    checkEqual(
      "the agreement's order is snapshotted onto the invoice",
      snapshot!.order,
      "fees_first",
    );

    // ── fees_first: the reported bug ────────────────────────────────────────
    section("fees_first applies to the firm's fee before the client's costs");

    await pay(feesFirstInvoice, 600);
    let split = await paidBySide(feesFirstInvoice);
    checkEqual("the whole $600 lands in operating", split.operating, 600);
    checkEqual("and nothing in trust", split.trust, 0);

    // ── costs_first ─────────────────────────────────────────────────────────
    section("costs_first applies to costs, funding trust before operating ones");

    // These two confirm correctness rather than distinguish the rules. For a
    // fee agreement's line shape, costs_first and the old trust-first default
    // agree: every trust line is a cost, so "costs first" and "trust first"
    // reach for the same money. They only diverge on an invoice with a fee line
    // in trust, which nothing produces today. Verified by reverting the fix —
    // the fees_first, custom and cumulative assertions all fail, and these do
    // not.

    const costsFirstInvoice = await seedInvoice({ order: "costs_first" });
    await pay(costsFirstInvoice, 600);
    split = await paidBySide(costsFirstInvoice);
    checkEqual("the filing fee is funded in full", split.trust, 500);
    checkEqual("and the rest goes to the operating cost", split.operating, 100);

    // ── custom ──────────────────────────────────────────────────────────────
    section("custom splits by the stated percentage");

    const customInvoice = await seedInvoice({
      order: "custom",
      customFeePercent: 60,
    });
    await pay(customInvoice, 1000);
    split = await paidBySide(customInvoice);
    // 60% of $1,000 to fees; the $400 costs share funds trust first.
    checkEqual("60% reaches the fee side", split.operating, 600);
    checkEqual("40% reaches the costs, trust first", split.trust, 400);

    // ── The regression guard ────────────────────────────────────────────────
    section("An agreement with no clause is unchanged");

    const legacyInvoice = await seedInvoice(null);
    const [legacy] = await systemDb
      .select({ order: invoices.paymentApplicationOrder })
      .from(invoices)
      .where(eq(invoices.id, legacyInvoice))
      .limit(1);
    check("no order is snapshotted", legacy!.order === null);

    await pay(legacyInvoice, 600);
    split = await paidBySide(legacyInvoice);
    checkEqual("trust is filled first, exactly as before", split.trust, 500);
    checkEqual("and the remainder goes to operating", split.operating, 100);

    // ── Repeated payments ───────────────────────────────────────────────────
    section("Repeated payments walk the invoice rather than restart it");

    await pay(feesFirstInvoice, 600);
    split = await paidBySide(feesFirstInvoice);
    checkEqual(
      "the fee side is finished and the overflow reaches trust",
      split.operating,
      1000,
    );
    checkEqual("trust picks up the balance of the second payment", split.trust, 200);

    await pay(feesFirstInvoice, 500);
    split = await paidBySide(feesFirstInvoice);
    checkEqual("the last payment settles trust", split.trust, 500);
    checkEqual("and the operating costs", split.operating, 1200);

    const [settled] = await systemDb
      .select({ balanceDue: invoices.balanceDue, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, feesFirstInvoice))
      .limit(1);
    check("the invoice is settled exactly", num(settled!.balanceDue) <= 0.005);
    check(
      "and never driven into credit",
      num(settled!.balanceDue) >= -0.005,
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
