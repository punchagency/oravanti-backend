/**
 * Finance module end-to-end check.
 *
 * Proves the behaviours that are easy to get subtly wrong and impossible to
 * eyeball from the UI:
 *
 *   - invoice numbers are per-org, zero-padded, and monotonic
 *   - operating/trust subtotals fold correctly from line items
 *   - a partial payment lands on `partial`, the remainder flips it to `paid`
 *   - payment splits are pro-rated against the OUTSTANDING balance, and stored
 *   - a time entry can be billed exactly once
 *   - overdue outranks partial in the status buckets
 *   - billing rates resolve by the entry's date, not today's
 *   - the approve path re-resolves a rate; the invoiced path does not
 *   - trust figures are omitted, not zeroed, without access
 *
 * Runs against the TEST database (npm run check 12-finance) and cleans up the
 * org it creates.
 */
import { randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import { organization, user } from "../../src/db/schema/auth-schema";
import { billingRates } from "../../src/db/schema/billing-rates";
import { cases } from "../../src/db/schema/cases";
import { clients } from "../../src/db/schema/clients";
import { financeEvents } from "../../src/db/schema/finance-events";
import { invoiceFollowups } from "../../src/db/schema/invoice-followups";
import { invoiceNumberSequences } from "../../src/db/schema/invoice-number-sequences";
import { invoicePayments } from "../../src/db/schema/invoice-payments";
import { invoiceLineItems, invoices } from "../../src/db/schema/invoices";
import { practiceAreaCaseTypes } from "../../src/db/schema/practice-area-case-types";
import { practiceAreaSubcategories } from "../../src/db/schema/practice-area-subcategories";
import { practiceAreas } from "../../src/db/schema/practice-areas";
import { staff } from "../../src/db/schema/staff";
import { timeEntries } from "../../src/db/schema/time-entries";
import { pickFinanceRole } from "../../src/modules/finance/account-access";
import {
  resolveBillingRate,
  setBillingRate,
} from "../../src/modules/finance/billing-rates.service";
import * as invoicesService from "../../src/modules/finance/invoices.service";
import { formatInvoiceNumber } from "../../src/modules/finance/invoice-number";
import { proRateSplit, toMoney } from "../../src/modules/finance/money";
import * as paymentsService from "../../src/modules/finance/payments.service";
import * as reportsService from "../../src/modules/finance/reports.service";
import * as timeBilling from "../../src/modules/finance/time-billing.service";
import { deriveStoredStatus } from "../../src/modules/finance/totals";
import type { AccountAccess } from "../../src/modules/finance/types";
import { check, checkEqual, report, section, withOrgContext } from "./_bootstrap";

const FULL: AccountAccess = { operating: "full_access", trust: "full_access" };
const NO_TRUST: AccountAccess = { operating: "full_access", trust: "no_access" };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) =>
  iso(new Date(Date.now() + n * 86_400_000));

const main = async () => {
  const orgId = `fin-check-${randomUUID()}`;
  const userId = `user-${randomUUID()}`;
  let staffAId = "";
  let staffBId = "";
  let clientId = "";
  let caseId = "";
  let practiceAreaId = "";
  let subcategoryId = "";

  // ── Fixture ────────────────────────────────────────────────────────────────
  await systemDb.insert(organization).values({
    id: orgId,
    name: "Finance Check Firm",
    slug: `fin-${randomUUID().slice(0, 8)}`,
    createdAt: new Date(),
  });
  await systemDb.insert(user).values({
    id: userId,
    name: "Fin Checker",
    email: `fin-${randomUUID().slice(0, 8)}@example.test`,
    emailVerified: true,
    accountType: "firm_admin",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const [area] = await systemDb
    .insert(practiceAreas)
    .values({ name: `Immigration ${randomUUID().slice(0, 6)}` })
    .returning();
  practiceAreaId = area!.id;
  const [sub] = await systemDb
    .insert(practiceAreaSubcategories)
    .values({ practiceAreaId, code: `FAM${randomUUID().slice(0, 4)}`, name: "Family" })
    .returning();
  subcategoryId = sub!.id;
  const [caseType] = await systemDb
    .insert(practiceAreaCaseTypes)
    .values({
      subcategoryId: sub!.id,
      code: `I485${randomUUID().slice(0, 4)}`,
      name: "I-485 Adjustment of Status",
      caseNumberPrefix: "IMM",
      jurisdiction: "federal",
    })
    .returning();

  const [staffA] = await systemDb
    .insert(staff)
    .values({
      organizationId: orgId,
      userId,
      firstName: "Ada",
      lastName: "Attorney",
      email: `ada-${randomUUID().slice(0, 6)}@example.test`,
      role: "attorney",
      status: "active",
    })
    .returning();
  staffAId = staffA!.id;

  const [staffB] = await systemDb
    .insert(staff)
    .values({
      organizationId: orgId,
      firstName: "Ben",
      lastName: "Approver",
      email: `ben-${randomUUID().slice(0, 6)}@example.test`,
      role: "admin",
      status: "active",
    })
    .returning();
  staffBId = staffB!.id;

  const [client] = await systemDb
    .insert(clients)
    .values({
      organizationId: orgId,
      firstName: "Amara",
      lastName: "Chen",
      displayName: "Amara Chen",
      email: "amara.chen@example.test",
      phone: "+15550100",
      entityType: "individual",
      status: "active",
    })
    .returning();
  clientId = client!.id;

  const [kase] = await systemDb
    .insert(cases)
    .values({
      organizationId: orgId,
      caseNumber: `2026-IMM-${randomUUID().slice(0, 6)}`,
      description: "Adjustment of status",
      clientId,
      practiceAreaId,
      caseTypeId: caseType!.id,
      billingType: "hourly",
      openedById: staffBId,
    })
    .returning();
  caseId = kase!.id;

  try {
    await withOrgContext(orgId, userId, async () => {
      // ── Pure helpers ──────────────────────────────────────────────────────
      section("money + status helpers");

      checkEqual("invoice number pads to 4", formatInvoiceNumber(2026, 42), "INV-2026-0042");
      checkEqual("invoice number at 4 digits", formatInvoiceNumber(2026, 1234), "INV-2026-1234");

      checkEqual(
        "overpayment marks paid, not partial",
        deriveStoredStatus("partial", 100, 120),
        "paid",
      );
      checkEqual(
        "part payment marks partial",
        deriveStoredStatus("sent", 100, 40),
        "partial",
      );
      checkEqual(
        "refund to zero returns to sent",
        deriveStoredStatus("partial", 100, 0),
        "sent",
      );
      checkEqual(
        "void never transitions out",
        deriveStoredStatus("void", 100, 100),
        "void",
      );

      const split = proRateSplit(600, 500, 1500);
      checkEqual("pro-rata trust share", split.trust, 450);
      checkEqual("pro-rata operating share", split.operating, 150);
      checkEqual(
        "pro-rata split sums exactly",
        toMoney(split.operating + split.trust),
        600,
      );

      // ── Finance role resolution ───────────────────────────────────────────
      section("finance role resolution");

      // Better Auth's member.role is org membership; staff.role is the
      // professional role financial_access_controls is keyed on. Preferring
      // member.role outright meant most staff resolved to the generic
      // "member", which maps to no permission role at all — so the controls
      // table was never read and every attorney silently got the defaults.
      checkEqual(
        "a plain member falls through to their staff role",
        pickFinanceRole("member", "attorney"),
        "attorney",
      );
      checkEqual(
        "org owner wins over staff role",
        pickFinanceRole("owner", "admin"),
        "owner",
      );
      checkEqual(
        "org admin wins over staff role",
        pickFinanceRole("admin", "paralegal"),
        "admin",
      );
      checkEqual(
        "no membership row still resolves from staff",
        pickFinanceRole(null, "paralegal"),
        "paralegal",
      );
      checkEqual(
        "an owner with no staff row still resolves",
        pickFinanceRole("owner", null),
        "owner",
      );
      checkEqual(
        "nothing to go on resolves to nothing",
        pickFinanceRole(null, null),
        null,
      );

      // ── Billing rates ─────────────────────────────────────────────────────
      section("billing rates resolve by entry date");

      await setBillingRate({
        organizationId: orgId,
        staffId: staffAId,
        rate: 100,
        effectiveFrom: "2020-01-01",
      });
      await setBillingRate({
        organizationId: orgId,
        staffId: staffAId,
        rate: 200,
        effectiveFrom: "2026-06-10",
      });

      const before = await resolveBillingRate(orgId, staffAId, "2026-06-03");
      const dayBefore = await resolveBillingRate(orgId, staffAId, "2026-06-09");
      const onDay = await resolveBillingRate(orgId, staffAId, "2026-06-10");
      const after = await resolveBillingRate(orgId, staffAId, "2026-06-12");

      checkEqual("work before the raise bills at the old rate", before.rate, 100);
      checkEqual("day before the raise bills at the old rate", dayBefore.rate, 100);
      checkEqual("raise day bills at the new rate", onDay.rate, 200);
      checkEqual("after the raise bills at the new rate", after.rate, 200);

      // Role fallback for someone with no personal rate.
      await setBillingRate({
        organizationId: orgId,
        role: "admin",
        rate: 75,
        effectiveFrom: "2020-01-01",
      });
      const roleFallback = await resolveBillingRate(orgId, staffBId, "2026-06-12");
      checkEqual("falls back to the role default", roleFallback.rate, 75);
      checkEqual("and reports the source", roleFallback.source, "role");
      checkEqual("personal rate outranks role default", after.source, "staff");

      // ── Time entries ──────────────────────────────────────────────────────
      section("time entries");

      const backdated = await timeBilling.create(orgId, staffAId, false, {
        staffId: staffAId,
        caseId,
        entryDate: "2026-06-03",
        hoursWorked: 2,
        description: "Attorney consultation",
        billable: true,
      });
      checkEqual(
        "back-dated entry priced at the old rate",
        Number(backdated.amount),
        200,
      );

      const recent = await timeBilling.create(orgId, staffAId, false, {
        staffId: staffAId,
        caseId,
        entryDate: "2026-06-12",
        hoursWorked: 1.5,
        description: "Form preparation",
        billable: true,
      });
      checkEqual("recent entry priced at the new rate", Number(recent.amount), 300);

      const nonBillable = await timeBilling.create(orgId, staffAId, false, {
        staffId: staffAId,
        caseId,
        entryDate: "2026-06-12",
        hoursWorked: 1,
        description: "Internal admin",
        billable: false,
      });
      checkEqual("non-billable entry has no amount", nonBillable.amount, null);

      let selfApproveRejected = false;
      try {
        await timeBilling.approve(orgId, backdated.id, staffAId);
      } catch {
        selfApproveRejected = true;
      }
      check("an entry cannot be approved by its author", selfApproveRejected);

      await timeBilling.approve(orgId, backdated.id, staffBId);
      await timeBilling.approve(orgId, recent.id, staffBId);

      const stats = await timeBilling.getStats(orgId);
      checkEqual("hours logged counts non-billable too", stats.hoursLogged, 4.5);
      checkEqual("billable hours excludes it", stats.billableHours, 3.5);
      checkEqual("earnings sum the snapshots", stats.totalEarnings, 500);
      checkEqual("pending count after approvals", stats.pendingCount, 1);

      // ── Invoice creation ──────────────────────────────────────────────────
      section("invoice creation");

      const invoice = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        attorneyId: staffAId,
        issueDate: daysFromNow(-5),
        dueDate: daysFromNow(10),
        status: "sent",
        lineItems: [
          {
            description: "USCIS I-485 filing fee",
            quantity: 1,
            rate: 1440,
            account: "trust_iolta",
          },
        ],
        timeEntryIds: [backdated.id, recent.id],
      });

      checkEqual("first invoice is 0001", invoice.invoiceNumber.slice(-4), "0001");
      checkEqual("operating subtotal folds the time entries", invoice.totals.operating, 500);
      checkEqual("trust subtotal folds the filing fee", invoice.totals.trust, 1440);
      checkEqual("total is the sum", invoice.totals.total, 1940);
      checkEqual("balance starts at the total", invoice.totals.balanceDue, 1940);
      checkEqual("line count", invoice.lineItems.length, 3);

      const invoicedEntries = await systemDb
        .select({ invoicedAt: timeEntries.invoicedAt })
        .from(timeEntries)
        .where(inArray(timeEntries.id, [backdated.id, recent.id]));
      check(
        "billed time entries are marked invoiced",
        invoicedEntries.every((e) => e.invoicedAt != null),
      );

      let doubleBillRejected = false;
      try {
        await invoicesService.create(orgId, staffBId, FULL, {
          clientId,
          caseId,
          issueDate: daysFromNow(-1),
          dueDate: daysFromNow(20),
          status: "sent",
          lineItems: [],
          timeEntryIds: [backdated.id],
        });
      } catch {
        doubleBillRejected = true;
      }
      check("the same time entry cannot be billed twice", doubleBillRejected);

      const second = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        practiceAreaId,
        issueDate: daysFromNow(-40),
        dueDate: daysFromNow(-20),
        status: "sent",
        lineItems: [
          { description: "Consultation", quantity: 1, rate: 300, account: "operating" },
        ],
        timeEntryIds: [],
      });
      checkEqual("second invoice increments", second.invoiceNumber.slice(-4), "0002");

      // ── Payments ──────────────────────────────────────────────────────────
      section("payments");

      const afterPartial = await paymentsService.recordPayment(
        orgId,
        invoice.id,
        staffBId,
        FULL,
        {
          amount: 940,
          paymentDate: daysFromNow(-1),
          method: "bank_transfer",
          reference: "TXN-1",
        },
      );
      checkEqual("partial payment sets partial", afterPartial.status, "partial");
      checkEqual("amount paid tracks", afterPartial.totals.amountPaid, 940);
      checkEqual("balance falls", afterPartial.totals.balanceDue, 1000);
      checkEqual(
        "the detail view shows the last method",
        afterPartial.lastPaymentMethod,
        "bank_transfer",
      );

      const [storedSplit] = await systemDb
        .select({
          operating: invoicePayments.amountOperating,
          trust: invoicePayments.amountTrust,
        })
        .from(invoicePayments)
        .where(eq(invoicePayments.invoiceId, invoice.id));
      // 940 apportioned over 500 operating / 1440 trust outstanding.
      checkEqual(
        "trust share is stored, not inferred",
        Number(storedSplit!.trust),
        toMoney((940 * 1440) / 1940),
      );
      checkEqual(
        "the split sums to the payment",
        toMoney(Number(storedSplit!.operating) + Number(storedSplit!.trust)),
        940,
      );

      const afterFull = await paymentsService.recordPayment(
        orgId,
        invoice.id,
        staffBId,
        FULL,
        { amount: 1000, paymentDate: daysFromNow(0), method: "credit_card" },
      );
      checkEqual("the remainder settles the invoice", afterFull.status, "paid");
      checkEqual("nothing left owing", afterFull.totals.balanceDue, 0);

      // ── Status bucketing ──────────────────────────────────────────────────
      section("status buckets and stats");

      const overdueList = await invoicesService.list(orgId, FULL, {
        status: "overdue",
      });
      checkEqual("the past-due invoice is overdue", overdueList.data.length, 1);
      checkEqual(
        "and it is the right one",
        overdueList.data[0]!.invoiceNumber,
        second.invoiceNumber,
      );

      const paidList = await invoicesService.list(orgId, FULL, { status: "paid" });
      checkEqual("the settled invoice is paid", paidList.data.length, 1);

      const invStats = await invoicesService.getStats(orgId, FULL);
      checkEqual("total invoiced", invStats.totalInvoiced, 2240);
      checkEqual("collected", invStats.collected, 1940);
      checkEqual("outstanding", invStats.outstanding, 300);
      checkEqual("overdue count", invStats.overdueCount, 1);
      checkEqual("trust total visible with access", invStats.trustTotal, 1440);

      const aging = await invoicesService.getAging(orgId);
      const bucket31 = aging.find((b) => b.key === "31_plus")!;
      checkEqual("the 20-day-overdue invoice is not in 31+", bucket31.amount, 0);
      const bucket16 = aging.find((b) => b.key === "16_30")!;
      checkEqual("it lands in 16-30", bucket16.amount, 300);

      // ── Trust gating ──────────────────────────────────────────────────────
      section("trust gating omits rather than zeroes");

      const maskedStats = await invoicesService.getStats(orgId, NO_TRUST);
      checkEqual("trust total is null without access", maskedStats.trustTotal, null);
      checkEqual(
        "but the headline total still includes trust",
        maskedStats.totalInvoiced,
        2240,
      );

      const maskedList = await invoicesService.list(orgId, NO_TRUST, {});
      check(
        "row trust amounts are null, not 0",
        maskedList.data.every((r) => r.trustAmount === null),
      );
      checkEqual(
        "restrictions are echoed for the UI",
        maskedList.restrictions.trust,
        "no_access",
      );

      const maskedDetail = await invoicesService.getById(orgId, invoice.id, NO_TRUST);
      check(
        "trust line items are withheld entirely",
        maskedDetail.lineItems.every((l) => l.account === "operating"),
      );

      let trustWriteBlocked = false;
      try {
        await invoicesService.create(orgId, staffBId, NO_TRUST, {
          clientId,
          practiceAreaId,
          issueDate: daysFromNow(0),
          dueDate: daysFromNow(30),
          status: "sent",
          lineItems: [
            { description: "Filing fee", quantity: 1, rate: 500, account: "trust_iolta" },
          ],
          timeEntryIds: [],
        });
      } catch {
        trustWriteBlocked = true;
      }
      check("writing a trust line without access is refused", trustWriteBlocked);

      // ── Follow-up ─────────────────────────────────────────────────────────
      section("payment follow-up");

      const followup = await paymentsService.sendFollowUp(orgId, second.id, staffBId, {
        message: "Gentle reminder that this invoice is now overdue.",
        channel: "both",
      });
      check("follow-up records days overdue", followup.daysOverdue >= 19);
      checkEqual("sms is not claimed as delivered", followup.smsDelivered, false);

      let paidFollowupBlocked = false;
      try {
        await paymentsService.sendFollowUp(orgId, invoice.id, staffBId, {
          message: "x",
          channel: "email",
        });
      } catch {
        paidFollowupBlocked = true;
      }
      check("a paid invoice cannot be chased", paidFollowupBlocked);

      // ── Reports ───────────────────────────────────────────────────────────
      section("reports");

      const month = daysFromNow(-5).slice(0, 7);
      const rpt = await reportsService.getMonthlyReport(orgId, FULL, month);
      check("the month's revenue is reported", rpt.summary.totalRevenue > 0);
      checkEqual(
        "account split percentages total 100",
        rpt.accountSplit.operatingPercent + (rpt.accountSplit.trustPercent ?? 0),
        100,
      );
      const bucketCount = rpt.collectionStatus.reduce((a, b) => a + b.count, 0);
      checkEqual(
        "every invoice lands in exactly one status bucket",
        bucketCount,
        rpt.summary.invoiceCount,
      );
      // Counts alone used to be all this asserted, which let a real bug
      // through: `paid` summed invoice totals while the other three summed
      // outstanding balances, so the breakdown added up to neither revenue nor
      // outstanding. Every bucket now reports the invoice total.
      const bucketAmount = rpt.collectionStatus.reduce((a, b) => a + b.amount, 0);
      checkEqual(
        "and the bucket amounts sum to total revenue",
        toMoney(bucketAmount),
        toMoney(rpt.summary.totalRevenue),
      );
      // Both fixture invoices in this month are due in the future, so nothing
      // is overdue. `overdue` previously omitted the due-date filter entirely
      // and was just a second copy of `outstanding`.
      checkEqual("nothing due in the future counts as overdue", rpt.summary.overdue, 0);
      checkEqual(
        "outstanding is exactly what was invoiced but not collected",
        toMoney(rpt.summary.outstanding),
        toMoney(rpt.summary.totalRevenue - rpt.summary.collected),
      );
      checkEqual(
        "aging declares its all-time scope",
        rpt.aging.scope,
        "all_time",
      );
      check(
        "trust reconciliation is present with access",
        rpt.trustReconciliation != null,
      );
      checkEqual(
        "and is honest about disbursements",
        rpt.trustReconciliation!.disbursementsTracked,
        false,
      );

      const maskedReport = await reportsService.getMonthlyReport(
        orgId,
        NO_TRUST,
        month,
      );
      checkEqual(
        "trust reconciliation is withheld without access",
        maskedReport.trustReconciliation,
        null,
      );

      // ── Void releases time ────────────────────────────────────────────────
      section("voiding releases billed time");

      const voided = await invoicesService.voidInvoice(
        orgId,
        invoice.id,
        "Issued in error",
        staffBId,
        FULL,
      );
      checkEqual("the invoice is void", voided.status, "void");

      const released = await systemDb
        .select({ invoicedAt: timeEntries.invoicedAt })
        .from(timeEntries)
        .where(inArray(timeEntries.id, [backdated.id, recent.id]));
      check(
        "its time entries can be billed again",
        released.every((e) => e.invoicedAt == null),
      );

      const statsAfterVoid = await invoicesService.getStats(orgId, FULL);
      checkEqual(
        "a voided invoice leaves the revenue figures",
        statsAfterVoid.totalInvoiced,
        300,
      );

      // ── Activity trail ────────────────────────────────────────────────────
      section("activity trail");

      const events = await systemDb
        .select({ eventType: financeEvents.eventType })
        .from(financeEvents)
        .where(eq(financeEvents.organizationId, orgId));
      const types = new Set(events.map((e) => e.eventType));
      check("invoice creation is recorded", types.has("invoice_sent"));
      check("payment is recorded", types.has("invoice_partially_paid"));
      check("settlement is recorded", types.has("invoice_paid"));
      check("follow-up is recorded", types.has("payment_followup_sent"));
      check("void is recorded", types.has("invoice_voided"));
      check("time approval is recorded", types.has("time_entry_approved"));
    });
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────
    const orgInvoices = await systemDb
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.organizationId, orgId));
    const invoiceIds = orgInvoices.map((i) => i.id);

    if (invoiceIds.length) {
      await systemDb
        .delete(invoiceFollowups)
        .where(inArray(invoiceFollowups.invoiceId, invoiceIds));
      await systemDb
        .delete(invoicePayments)
        .where(inArray(invoicePayments.invoiceId, invoiceIds));
      await systemDb
        .delete(invoiceLineItems)
        .where(inArray(invoiceLineItems.invoiceId, invoiceIds));
    }
    await systemDb.delete(financeEvents).where(eq(financeEvents.organizationId, orgId));
    await systemDb.delete(invoices).where(eq(invoices.organizationId, orgId));
    await systemDb
      .delete(invoiceNumberSequences)
      .where(eq(invoiceNumberSequences.organizationId, orgId));
    await systemDb.delete(timeEntries).where(eq(timeEntries.organizationId, orgId));
    await systemDb.delete(billingRates).where(eq(billingRates.organizationId, orgId));
    await systemDb.delete(cases).where(eq(cases.organizationId, orgId));
    await systemDb.delete(clients).where(eq(clients.organizationId, orgId));
    await systemDb.delete(staff).where(eq(staff.organizationId, orgId));
    await systemDb
      .delete(practiceAreaCaseTypes)
      .where(eq(practiceAreaCaseTypes.subcategoryId, subcategoryId));
    await systemDb
      .delete(practiceAreaSubcategories)
      .where(eq(practiceAreaSubcategories.practiceAreaId, practiceAreaId));
    await systemDb.delete(practiceAreas).where(eq(practiceAreas.id, practiceAreaId));
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
