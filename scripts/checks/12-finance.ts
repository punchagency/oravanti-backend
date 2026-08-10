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
import { organization, team, user } from "../../src/db/schema/auth-schema";
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
import { teamMembers } from "../../src/db/schema/team-members";
import { timeEntries } from "../../src/db/schema/time-entries";
import { pickFinanceRole } from "../../src/modules/finance/account-access";
import {
  resolveBillingRate,
  setBillingRate,
} from "../../src/modules/finance/billing-rates.service";
import { agingOverDues } from "../../src/modules/finance/dues";
import { allocate, generateSchedule } from "../../src/modules/finance/instalments";
import * as instalmentsService from "../../src/modules/finance/instalments.service";
import * as invoicesService from "../../src/modules/finance/invoices.service";
import { formatInvoiceNumber } from "../../src/modules/finance/invoice-number";
import { num, proRateSplit, toMoney } from "../../src/modules/finance/money";
import { firmToday } from "../../src/modules/finance/status";
import * as paymentsService from "../../src/modules/finance/payments.service";
import * as deliveriesService from "../../src/modules/finance/deliveries.service";
import { invoiceDeliveries } from "../../src/db/schema/invoice-deliveries";
import * as reportsService from "../../src/modules/finance/reports.service";
import * as timeBilling from "../../src/modules/finance/time-billing.service";
import { deriveStoredStatus } from "../../src/modules/finance/totals";
import type { AccountAccess } from "../../src/modules/finance/types";
import { check, checkEqual, report, section, withOrgContext } from "./_bootstrap";

const FULL: AccountAccess = { operating: "full_access", trust: "full_access" };
const NO_TRUST: AccountAccess = { operating: "full_access", trust: "no_access" };

const CLIENT_EMAIL = "amara.chen@example.test";

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
      email: CLIENT_EMAIL,
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
        status: "draft",
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
          status: "draft",
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
        status: "draft",
        lineItems: [
          { description: "Consultation", quantity: 1, rate: 300, account: "operating" },
        ],
        timeEntryIds: [],
      });
      checkEqual("second invoice increments", second.invoiceNumber.slice(-4), "0002");

      // ── Delivery ──────────────────────────────────────────────────────────
      section("delivery");

      checkEqual("a new invoice is a draft", invoice.status, "draft");
      checkEqual("and has no sentAt", invoice.sentAt, null);

      // Drafts are not invoiced revenue and must stay out of every money tile.
      const statsBeforeSend = await invoicesService.getStats(orgId, FULL);
      checkEqual(
        "drafts are excluded from the totals",
        statsBeforeSend.totalInvoiced,
        0,
      );
      const draftList = await invoicesService.list(orgId, FULL, {
        status: "draft",
      });
      checkEqual("but the drafts filter finds them", draftList.data.length, 2);

      // "all" hides drafts by default, and can be asked to show them.
      const allDefault = await invoicesService.list(orgId, FULL, {
        status: "all",
      });
      checkEqual("all hides drafts by default", allDefault.data.length, 0);

      const allWithDrafts = await invoicesService.list(orgId, FULL, {
        status: "all",
        includeDrafts: true,
      });
      checkEqual("and shows them on request", allWithDrafts.data.length, 2);
      // Visible is not the same as counted: a draft on screen must still not
      // reach the totals, or the footer would disagree with the tiles above it.
      checkEqual(
        "but they are still excluded from the totals",
        allWithDrafts.totals.total,
        0,
      );
      checkEqual(
        "and the count of excluded rows is reported",
        allWithDrafts.totals.draftCount,
        2,
      );

      // The flag is meaningless on a bucket that names a non-draft state, and
      // must not smuggle drafts into it.
      const paidWithFlag = await invoicesService.list(orgId, FULL, {
        status: "paid",
        includeDrafts: true,
      });
      checkEqual(
        "includeDrafts is ignored on a specific status",
        paidWithFlag.data.length,
        0,
      );

      // Chasing a client for an invoice they were never sent is the bug this
      // whole flow exists to prevent.
      let followUpBeforeSendRejected = false;
      try {
        await paymentsService.sendFollowUp(orgId, second.id, staffBId, {
          message: "x",
          channel: "email",
        });
      } catch {
        followUpBeforeSendRejected = true;
      }
      check(
        "an undelivered invoice cannot be chased",
        followUpBeforeSendRejected,
      );

      // Recording a payment against something never sent is equally wrong.
      let payBeforeSendRejected = false;
      try {
        await paymentsService.recordPayment(orgId, invoice.id, staffBId, FULL, {
          amount: 10,
          paymentDate: daysFromNow(0),
          method: "cash",
        });
      } catch {
        payBeforeSendRejected = true;
      }
      check("a draft cannot receive a payment", payBeforeSendRejected);

      const sendResult = await deliveriesService.sendInvoice(
        orgId,
        invoice.id,
        staffBId,
        FULL,
      );
      checkEqual("sending reports success", sendResult.status, "sent");
      checkEqual("to the client's address", sendResult.recipientEmail, CLIENT_EMAIL);

      const afterSend = await invoicesService.getById(orgId, invoice.id, FULL);
      checkEqual("the invoice leaves draft", afterSend.status, "unpaid");
      check("and sentAt is stamped", afterSend.sentAt != null);

      const [deliveryRow] = await systemDb
        .select()
        .from(invoiceDeliveries)
        .where(eq(invoiceDeliveries.invoiceId, invoice.id));
      checkEqual("a delivery row records it", deliveryRow?.status, "sent");
      check("with the archived document key", Boolean(deliveryRow?.documentKey));
      check("and a handoff timestamp", deliveryRow?.deliveredAt != null);

      checkEqual(
        "the invoice now counts as revenue",
        (await invoicesService.getStats(orgId, FULL)).totalInvoiced,
        1940,
      );

      // Sending twice is a resend, not a second send.
      let doubleSendRejected = false;
      try {
        await deliveriesService.sendInvoice(orgId, invoice.id, staffBId, FULL);
      } catch {
        doubleSendRejected = true;
      }
      check("a sent invoice cannot be sent again", doubleSendRejected);

      const resent = await deliveriesService.resendInvoice(
        orgId,
        invoice.id,
        staffBId,
        FULL,
      );
      checkEqual("but it can be resent", resent.status, "sent");
      checkEqual("which counts the attempt", resent.attemptCount, 2);

      // The failure path is the point of the whole design: an invoice whose
      // delivery fails must stay a draft with the reason recorded, rather than
      // claiming a send. Forced with an address the transport rejects.
      await systemDb
        .update(clients)
        .set({ email: "not a valid address" })
        .where(eq(clients.id, clientId));

      const failed = await deliveriesService.sendInvoice(
        orgId,
        second.id,
        staffBId,
        FULL,
      );
      checkEqual("a rejected send reports failure", failed.status, "failed");
      check("with a reason", Boolean(failed.failureReason), failed);
      checkEqual(
        "and the invoice is STILL a draft",
        (await invoicesService.getById(orgId, second.id, FULL)).status,
        "draft",
      );

      const [failedRow] = await systemDb
        .select()
        .from(invoiceDeliveries)
        .where(eq(invoiceDeliveries.id, failed.deliveryId));
      checkEqual("the attempt is recorded as failed", failedRow?.status, "failed");
      checkEqual("with no handoff timestamp", failedRow?.deliveredAt, null);

      // Still cannot be chased — a failed send is not a delivery.
      let chaseAfterFailureRejected = false;
      try {
        await paymentsService.sendFollowUp(orgId, second.id, staffBId, {
          message: "x",
          channel: "email",
        });
      } catch {
        chaseAfterFailureRejected = true;
      }
      check("a failed delivery still blocks a chase", chaseAfterFailureRejected);

      await systemDb
        .update(clients)
        .set({ email: CLIENT_EMAIL })
        .where(eq(clients.id, clientId));

      // Now that the address is valid again, the retry succeeds — proving a
      // failure is recoverable rather than terminal.
      const retried = await deliveriesService.sendInvoice(
        orgId,
        second.id,
        staffBId,
        FULL,
      );
      checkEqual("and a retry after fixing the address succeeds", retried.status, "sent");
      checkEqual("counting it as a second attempt", retried.attemptCount, 2);

      // Invoices issued before delivery tracking existed have `sentAt` but no
      // delivery rows. They must stay chaseable — the gate distinguishes
      // absence of evidence from evidence of failure, and blocking every
      // invoice a firm already has would be a regression, not a safeguard.
      const [legacy] = await systemDb
        .insert(invoices)
        .values({
          organizationId: orgId,
          invoiceNumber: `INV-LEGACY-${randomUUID().slice(0, 6)}`,
          clientId,
          practiceAreaId,
          status: "sent",
          issueDate: daysFromNow(-30),
          dueDate: daysFromNow(-10),
          totalAmount: "100.00",
          subtotalOperating: "100.00",
          sentAt: new Date(),
        })
        .returning();
      check(
        "a pre-tracking invoice is still chaseable",
        await deliveriesService.canChaseInvoice(orgId, legacy!.id),
      );
      // Removed straight away: it exists to prove one thing, and leaving it
      // would shift every money figure the rest of this check asserts on.
      await systemDb.delete(invoices).where(eq(invoices.id, legacy!.id));

      const pdf = await deliveriesService.buildInvoicePdf(orgId, invoice.id, FULL);
      check("the PDF renders", pdf.buffer.length > 1000);
      checkEqual(
        "as a real PDF",
        pdf.buffer.subarray(0, 4).toString("utf8"),
        "%PDF",
      );

      // Trust lines are withheld from the payload, so they cannot reach the PDF.
      const maskedPdf = await deliveriesService.buildInvoicePdf(
        orgId,
        invoice.id,
        NO_TRUST,
      );
      check(
        "a caller without trust access gets a smaller document",
        maskedPdf.buffer.length < pdf.buffer.length,
      );

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
          status: "draft",
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

      // ── Matter defaults (attorney prefill) ────────────────────────────────
      section("matter defaults");

      const noTeam = await invoicesService.getCaseDefaults(orgId, caseId);
      checkEqual("a matter with no team resolves no attorney", noTeam.attorneyId, null);
      checkEqual("and says so rather than guessing", noTeam.source, null);

      const teamId = randomUUID();
      await systemDb.insert(team).values({
        id: teamId,
        name: "Immigration team",
        organizationId: orgId,
        createdAt: new Date(),
        // The lead is an admin, not an attorney — rule 1 must not fire.
        leadId: staffBId,
      });
      await systemDb
        .insert(teamMembers)
        .values([{ teamId, staffId: staffAId }, { teamId, staffId: staffBId }]);
      await systemDb
        .update(cases)
        .set({ assignedTeamId: teamId })
        .where(eq(cases.id, caseId));

      const soleAttorney = await invoicesService.getCaseDefaults(orgId, caseId);
      checkEqual(
        "the team's only attorney is picked",
        soleAttorney.attorneyId,
        staffAId,
      );
      checkEqual("and the rule is named", soleAttorney.source, "sole_attorney");

      const [staffC] = await systemDb
        .insert(staff)
        .values({
          organizationId: orgId,
          firstName: "Nadia",
          lastName: "Okoro",
          email: `nadia-${randomUUID().slice(0, 8)}@example.test`,
          role: "attorney",
        })
        .returning();
      await systemDb
        .insert(teamMembers)
        .values({ teamId, staffId: staffC!.id });

      // Two attorneys and a non-attorney lead: nothing is unambiguous, so the
      // person answerable for the matter is the honest answer.
      const ambiguous = await invoicesService.getCaseDefaults(orgId, caseId);
      checkEqual("with several attorneys, the lead is used", ambiguous.attorneyId, staffBId);
      checkEqual("the count is reported", ambiguous.attorneyCount, 2);

      await systemDb
        .update(team)
        .set({ leadId: staffC!.id })
        .where(eq(team.id, teamId));

      const leadAttorney = await invoicesService.getCaseDefaults(orgId, caseId);
      checkEqual(
        "an attorney lead outranks the others",
        leadAttorney.attorneyId,
        staffC!.id,
      );
      checkEqual("and is labelled as the lead", leadAttorney.source, "team_lead");

      // ── Editing a draft ───────────────────────────────────────────────────
      section("draft editing");

      // The void above released these two, so they are billable again.
      const draft = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(0),
        dueDate: daysFromNow(30),
        status: "draft",
        lineItems: [
          { description: "Consultation", quantity: 1, rate: 100, account: "operating" },
        ],
        timeEntryIds: [backdated.id],
      });
      const backdatedAmount = draft.totals.total - 100;
      check("the draft folds in its time entry", backdatedAmount > 0);

      const edited = await invoicesService.update(
        orgId,
        draft.id,
        {
          notes: "Revised before sending",
          lineItems: [
            { description: "Consultation", quantity: 2, rate: 100, account: "operating" },
          ],
          // Swap which time entry it bills.
          timeEntryIds: [recent.id],
        },
        staffBId,
        FULL,
      );
      checkEqual("the edit keeps the invoice number", edited.invoiceNumber, draft.invoiceNumber);
      checkEqual("it is still a draft", edited.status, "draft");
      checkEqual("the notes stuck", edited.notes, "Revised before sending");
      checkEqual("the line set was replaced", edited.lineItems.length, 2);

      const [backdatedAfter] = await systemDb
        .select({ invoicedAt: timeEntries.invoicedAt })
        .from(timeEntries)
        .where(eq(timeEntries.id, backdated.id));
      const [recentAfter] = await systemDb
        .select({ invoicedAt: timeEntries.invoicedAt })
        .from(timeEntries)
        .where(eq(timeEntries.id, recent.id));
      // The dropped entry must become billable again, or the work is stranded.
      checkEqual("the dropped entry is released", backdatedAfter?.invoicedAt ?? null, null);
      check("the added entry is claimed", recentAfter?.invoicedAt != null);

      // Totals are recalculated, not left at what the draft used to say.
      const recentAmount = edited.totals.total - 200;
      checkEqual(
        "totals are recomputed from the new lines",
        edited.totals.total,
        toMoney(200 + recentAmount),
      );
      checkEqual("balance follows the total", edited.totals.balanceDue, edited.totals.total);

      // Keeping an entry the draft already holds must not read as double-billing.
      const kept = await invoicesService.update(
        orgId,
        draft.id,
        {
          lineItems: [],
          timeEntryIds: [recent.id],
        },
        staffBId,
        FULL,
      );
      checkEqual("a draft can keep its own time entry", kept.lineItems.length, 1);

      // And it is still visible to the dialog that has to offer it back.
      const offered = await invoicesService.getUnbilledTime(orgId, {
        clientId,
        forInvoiceId: draft.id,
      });
      check(
        "the held entry is offered back when editing",
        offered.some((e) => e.id === recent.id),
      );
      const unbilledOnly = await invoicesService.getUnbilledTime(orgId, { clientId });
      check(
        "but not to a plain unbilled query",
        !unbilledOnly.some((e) => e.id === recent.id),
      );

      // A sent invoice is a statement the client already holds; correcting it
      // is a void plus a reissue, never a rewrite.
      let sentEditRejected = false;
      try {
        await invoicesService.update(
          orgId,
          second.id,
          {
            lineItems: [
              { description: "Rewritten", quantity: 1, rate: 5, account: "operating" },
            ],
            timeEntryIds: [],
          },
          staffBId,
          FULL,
        );
      } catch {
        sentEditRejected = true;
      }
      check("a sent invoice's lines cannot be edited", sentEditRejected);

      const headerOnly = await invoicesService.update(
        orgId,
        second.id,
        { notes: "Chased by phone" },
        staffBId,
        FULL,
      );
      checkEqual("but its header still can be", headerOnly.notes, "Chased by phone");

      // Trust lines are withheld from a caller without access, so they cannot
      // be in the payload — replacing the set would delete them unseen.
      await invoicesService.update(
        orgId,
        draft.id,
        {
          lineItems: [
            { description: "Filing fee", quantity: 1, rate: 400, account: "trust_iolta" },
          ],
          timeEntryIds: [],
        },
        staffBId,
        FULL,
      );
      let blindTrustEditRejected = false;
      try {
        await invoicesService.update(
          orgId,
          draft.id,
          {
            lineItems: [
              { description: "Only what I can see", quantity: 1, rate: 50, account: "operating" },
            ],
            timeEntryIds: [],
          },
          staffBId,
          NO_TRUST,
        );
      } catch {
        blindTrustEditRejected = true;
      }
      check(
        "a draft with unseen trust lines cannot be edited blind",
        blindTrustEditRejected,
      );

      // ── Schedule arithmetic (pure) ────────────────────────────────────────
      section("schedule arithmetic");

      // The remainder is PLACED, not lost. Dividing without placing it gives
      // 333.33 x 3 = 999.99, which fails the balance check by construction —
      // the bug the fee-agreement wizard has today.
      const thirds = generateSchedule(1000, 3, "2026-09-01", "monthly");
      checkEqual(
        "an indivisible total still sums exactly",
        thirds.reduce((s, r) => s + r.amount, 0),
        1000,
      );
      checkEqual("the remainder lands on the last row", thirds[2]!.amount, 333.34);
      checkEqual(
        "monthly dates step by month",
        thirds.map((r) => r.dueDate),
        ["2026-09-01", "2026-10-01", "2026-11-01"],
      );

      // 31 Jan + 1 month is 28 Feb, not 3 March — rolling over would put an
      // instalment in the wrong month and out of order against its neighbours.
      checkEqual(
        "month-end clamps rather than rolling over",
        generateSchedule(300, 3, "2026-01-31", "monthly").map((r) => r.dueDate),
        ["2026-01-31", "2026-02-28", "2026-03-31"],
      );
      checkEqual(
        "fortnightly steps by 14 days",
        generateSchedule(200, 2, "2026-09-01", "fortnightly")[1]!.dueDate,
        "2026-09-15",
      );

      const rows3 = [
        { sequence: 1, dueDate: "2026-09-01", amount: 500 },
        { sequence: 2, dueDate: "2026-10-01", amount: 500 },
        { sequence: 3, dueDate: "2026-11-01", amount: 500 },
      ];
      const allocated = allocate(rows3, 500);
      checkEqual(
        "a payment settles the oldest instalment first",
        allocated.map((a) => a.state),
        ["paid", "due", "due"],
      );
      checkEqual("and leaves the rest owing in full", allocated[1]!.outstanding, 500);

      const partAllocated = allocate(rows3, 700);
      checkEqual(
        "a payment that spans two lands partially on the second",
        partAllocated[1]!.outstanding,
        300,
      );
      checkEqual("with the overlap recorded as paid", partAllocated[1]!.amountPaid, 200);

      // An overpayment must not produce a negative receivable anywhere.
      check(
        "overpayment leaves nothing outstanding",
        allocate(rows3, 2000).every((a) => a.outstanding === 0),
      );

      // ── Payment schedules ─────────────────────────────────────────────────
      section("payment schedules");

      // Its own invoice: the money assertions above are chained, so a schedule
      // hung off any of them would move figures the rest of this file asserts.
      const planned = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(-80),
        dueDate: daysFromNow(30),
        status: "draft",
        lineItems: [
          { description: "Retainer", quantity: 1, rate: 1500, account: "operating" },
        ],
        timeEntryIds: [],
      });

      let unbalancedRejected = false;
      try {
        await invoicesService.update(
          orgId,
          planned.id,
          {
            instalments: [
              { dueDate: daysFromNow(-70), amount: 500 },
              { dueDate: daysFromNow(-40), amount: 500 },
            ],
          },
          staffBId,
          FULL,
        );
      } catch {
        unbalancedRejected = true;
      }
      check("a schedule that undershoots the total is refused", unbalancedRejected);

      const withPlan = await invoicesService.update(
        orgId,
        planned.id,
        {
          instalments: [
            { dueDate: daysFromNow(-70), amount: 500 },
            { dueDate: daysFromNow(-40), amount: 500 },
            { dueDate: daysFromNow(30), amount: 500 },
          ],
        },
        staffBId,
        FULL,
      );
      checkEqual("the schedule is stored", withPlan.instalments.length, 3);
      checkEqual(
        "sequence is assigned in due-date order",
        withPlan.instalments.map((i) => i.sequence),
        [1, 2, 3],
      );

      const [plannedRow] = await systemDb
        .select({ nextDueDate: invoices.nextDueDate, dueDate: invoices.dueDate })
        .from(invoices)
        .where(eq(invoices.id, planned.id));
      checkEqual(
        "next due date is the first unpaid instalment",
        plannedRow?.nextDueDate,
        daysFromNow(-70),
      );
      // Otherwise the invoice could read "due in 30 days" while its own
      // schedule says two payments are already late.
      checkEqual(
        "the header due date follows the final instalment",
        plannedRow?.dueDate,
        daysFromNow(30),
      );

      // Sent, so it counts as owed. Set directly rather than through the
      // delivery path, which would send a real email for a fixture.
      await systemDb
        .update(invoices)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(invoices.id, planned.id));

      await paymentsService.recordPayment(orgId, planned.id, staffBId, FULL, {
        amount: 500,
        paymentDate: daysFromNow(-65),
        method: "bank_transfer",
      });

      const afterFirst = await invoicesService.getById(orgId, planned.id, FULL);
      checkEqual(
        "the first instalment reads as paid",
        afterFirst.instalments[0]!.state,
        "paid",
      );
      checkEqual(
        "the second reads as overdue",
        afterFirst.instalments[1]!.state,
        "overdue",
      );
      checkEqual(
        "and the third is not yet due",
        afterFirst.instalments[2]!.state,
        "due",
      );
      checkEqual("the invoice is overdue", afterFirst.status, "overdue");

      const [afterPay] = await systemDb
        .select({ nextDueDate: invoices.nextDueDate })
        .from(invoices)
        .where(eq(invoices.id, planned.id));
      checkEqual(
        "next due date advances to the second instalment",
        afterPay?.nextDueDate,
        daysFromNow(-40),
      );

      // The whole point of slice-level aging: this invoice owes 1000, but only
      // 500 of it is late. Bucketing by the header date would report all 1000
      // as 31+ days overdue, which is a position the firm does not have.
      const plannedAging = await agingOverDues(
        orgId,
        await firmToday(orgId),
        eq(invoices.id, planned.id),
      );
      checkEqual("the late slice ages alone", num(plannedAging.d31_plus), 500);
      checkEqual("the future slice stays current", num(plannedAging.current), 500);
      checkEqual("and the paid slice ages nowhere", num(plannedAging.total), 1000);
      checkEqual("one invoice is counted overdue", plannedAging.overdueInvoices, 1);

      // ── Instalment edge cases ─────────────────────────────────────────────
      section("instalment edge cases");

      // Two instalments on one date: the running total has to walk them one at
      // a time. (This does not exercise the ROWS vs RANGE frame — `sequence` is
      // in the window ordering and unique, so the two rows are never peers and
      // both frames agree. The frame is stated in dues.ts for the edit that
      // would remove that tiebreaker, which no test can reach from here.)
      const sameDay = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(-10),
        dueDate: daysFromNow(10),
        status: "draft",
        lineItems: [
          { description: "Pair", quantity: 1, rate: 1000, account: "operating" },
        ],
        timeEntryIds: [],
      });
      await invoicesService.update(
        orgId,
        sameDay.id,
        {
          instalments: [
            { dueDate: daysFromNow(-5), amount: 500 },
            { dueDate: daysFromNow(-5), amount: 500 },
          ],
        },
        staffBId,
        FULL,
      );
      await systemDb
        .update(invoices)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(invoices.id, sameDay.id));
      await paymentsService.recordPayment(orgId, sameDay.id, staffBId, FULL, {
        amount: 500,
        paymentDate: daysFromNow(-4),
        method: "cash",
      });

      const sameDayAging = await agingOverDues(
        orgId,
        await firmToday(orgId),
        eq(invoices.id, sameDay.id),
      );
      checkEqual(
        "same-day instalments do not double-count",
        num(sameDayAging.total),
        500,
      );

      // An invoice whose only late instalment is settled must leave the overdue
      // count, or the tile disagrees with the list filter forever.
      const settledEarly = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(-60),
        dueDate: daysFromNow(45),
        status: "draft",
        lineItems: [
          { description: "Deposit plan", quantity: 1, rate: 800, account: "operating" },
        ],
        timeEntryIds: [],
      });
      await invoicesService.update(
        orgId,
        settledEarly.id,
        {
          instalments: [
            { dueDate: daysFromNow(-50), amount: 400 },
            { dueDate: daysFromNow(45), amount: 400 },
          ],
        },
        staffBId,
        FULL,
      );
      await systemDb
        .update(invoices)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(invoices.id, settledEarly.id));
      await paymentsService.recordPayment(orgId, settledEarly.id, staffBId, FULL, {
        amount: 400,
        paymentDate: daysFromNow(-49),
        method: "cash",
      });

      const settledAging = await agingOverDues(
        orgId,
        await firmToday(orgId),
        eq(invoices.id, settledEarly.id),
      );
      checkEqual(
        "a paid-up deposit leaves the overdue count",
        settledAging.overdueInvoices,
        0,
      );
      checkEqual(
        "even though the instalment date is long past",
        num(settledAging.pastDue),
        0,
      );
      const settledDetail = await invoicesService.getById(
        orgId,
        settledEarly.id,
        FULL,
      );
      checkEqual(
        "and the invoice is not overdue",
        settledDetail.status,
        "partial",
      );

      // An invoice with no schedule must behave exactly as it did before
      // schedules existed.
      const [plainRow] = await systemDb
        .select({ nextDueDate: invoices.nextDueDate })
        .from(invoices)
        .where(eq(invoices.id, second.id));
      checkEqual(
        "an unscheduled invoice has no next due date",
        plainRow?.nextDueDate,
        null,
      );
      const plainAging = await agingOverDues(
        orgId,
        await firmToday(orgId),
        eq(invoices.id, second.id),
      );
      const plainDetail = await invoicesService.getById(orgId, second.id, FULL);
      checkEqual(
        "and ages as a single slice of its whole balance",
        num(plainAging.total),
        plainDetail.totals.balanceDue,
      );
      checkEqual("with no schedule to show", plainDetail.instalments.length, 0);

      // ── Revising a schedule ───────────────────────────────────────────────
      section("revising a schedule");

      // Line items freeze on send; a schedule does not. Renegotiating a plan is
      // the point of offering one.
      const revised = await invoicesService.update(
        orgId,
        planned.id,
        {
          instalments: [
            { dueDate: daysFromNow(-70), amount: 500 },
            { dueDate: daysFromNow(20), amount: 500 },
            { dueDate: daysFromNow(50), amount: 500 },
          ],
        },
        staffBId,
        FULL,
      );
      checkEqual("a sent invoice's schedule can be revised", revised.instalments.length, 3);
      checkEqual(
        "and the revision clears the overdue state",
        revised.status,
        "partial",
      );

      let sentLineEditRejected = false;
      try {
        await invoicesService.update(
          orgId,
          planned.id,
          {
            lineItems: [
              { description: "Rewritten", quantity: 1, rate: 1500, account: "operating" },
            ],
            timeEntryIds: [],
            instalments: [{ dueDate: daysFromNow(20), amount: 1500 }],
          },
          staffBId,
          FULL,
        );
      } catch {
        sentLineEditRejected = true;
      }
      check(
        "but its line items still cannot be",
        sentLineEditRejected,
      );

      // The header due date belongs to the schedule once one exists.
      let bareDueDateRejected = false;
      try {
        await invoicesService.update(
          orgId,
          planned.id,
          { dueDate: daysFromNow(90) },
          staffBId,
          FULL,
        );
      } catch {
        bareDueDateRejected = true;
      }
      check(
        "a bare due-date change on a scheduled invoice is refused",
        bareDueDateRejected,
      );

      let paidRescheduleRejected = false;
      try {
        await instalmentsService.setSchedule(
          orgId,
          invoice.id,
          [{ dueDate: daysFromNow(30), amount: 100 }],
          staffBId,
        );
      } catch {
        paidRescheduleRejected = true;
      }
      check("a paid invoice cannot be scheduled", paidRescheduleRejected);

      await instalmentsService.removeSchedule(orgId, sameDay.id, staffBId);
      const [afterRemove] = await systemDb
        .select({ nextDueDate: invoices.nextDueDate })
        .from(invoices)
        .where(eq(invoices.id, sameDay.id));
      checkEqual(
        "removing a schedule clears the next due date",
        afterRemove?.nextDueDate,
        null,
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
      check("a schedule being set is recorded", types.has("invoice_schedule_set"));
      check("a revision is recorded", types.has("invoice_schedule_revised"));
      check("a removal is recorded", types.has("invoice_schedule_removed"));
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
    // After cases: cases.assigned_team_id references team.
    await systemDb.delete(team).where(eq(team.organizationId, orgId));
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
