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
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { closeDb, systemDb } from "../../src/db/client";
import { organization, team, user } from "../../src/db/schema/auth-schema";
import { confidoFirms } from "../../src/db/schema/confido-firms";
import { billingRates } from "../../src/db/schema/billing-rates";
import { cases } from "../../src/db/schema/cases";
import { clients } from "../../src/db/schema/clients";
import { auditEvents } from "../../src/db/schema/audit-events";
import { invoiceFollowups } from "../../src/db/schema/invoice-followups";
import { invoiceNumberSequences } from "../../src/db/schema/invoice-number-sequences";
import { invoicePayments } from "../../src/db/schema/invoice-payments";
import { invoiceLinePresets } from "../../src/db/schema/invoice-line-presets";
import { invoiceLineItems, invoices } from "../../src/db/schema/invoices";
import { leads } from "../../src/db/schema/leads";
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
import * as linePresets from "../../src/modules/finance/line-presets.service";
import { allocate, generateSchedule } from "../../src/modules/finance/instalments";
import * as instalmentsService from "../../src/modules/finance/instalments.service";
import * as invoicesService from "../../src/modules/finance/invoices.service";
import { formatInvoiceNumber } from "../../src/modules/finance/invoice-number";
import { num, trustFirstSplit, toMoney } from "../../src/modules/finance/money";
import { firmToday } from "../../src/modules/finance/status";
import * as paymentsService from "../../src/modules/finance/payments.service";
import * as deliveriesService from "../../src/modules/finance/deliveries.service";
import { invoiceDeliveries } from "../../src/db/schema/invoice-deliveries";
import * as feeAgreementBilling from "../../src/modules/finance/fee-agreement-billing.service";
import { paymentsEnabledFor } from "../../src/modules/finance/confido/payments-enabled";
import * as paymentLinks from "../../src/modules/finance/payment-links.service";
import { paymentWebhookEvents } from "../../src/db/schema/payment-webhook-events";
import * as reportsService from "../../src/modules/finance/reports.service";
import * as timeBilling from "../../src/modules/finance/time-billing.service";
import { deriveStoredStatus } from "../../src/modules/finance/totals";
import type { AccountAccess } from "../../src/modules/finance/types";
import {
  check,
  checkEqual,
  report,
  section,
  silenceEmail,
  withOrgContext,
} from "./_bootstrap";

const FULL: AccountAccess = { operating: "full_access", trust: "full_access" };
const NO_TRUST: AccountAccess = { operating: "full_access", trust: "no_access" };

const CLIENT_EMAIL = "amara.chen@example.test";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) =>
  iso(new Date(Date.now() + n * 86_400_000));

const main = async () => {
  // Checks run against the real service layer, so an invoice send would reach a
  // live SMTP transport. Intercepted here rather than mocked per call site: the
  // point of this file is the ledger, and posting mail to whoever owns the
  // fixture addresses is not a side effect it should have.
  silenceEmail();

  const orgId = `fin-check-${randomUUID()}`;
  const userId = `user-${randomUUID()}`;
  let leadId = "";
  let staffAId = "";
  let staffBId = "";
  let clientId = "";
  let caseId = "";
  let practiceAreaId = "";
  // Shipped presets are not org-scoped, so cleanup has to be by the exact ids
  // this check invents — a blanket delete of NULL-org rows would wipe a real
  // catalog off a shared database.
  const presetIdsToClean: string[] = [];

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
  const subcategoryId = sub!.id;
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

  // Intake-stage party. Consultation fees and fee agreements are billed to a
  // lead, because no client row exists until openCase — which is itself gated
  // on the fee agreement being paid.
  const [lead] = await systemDb
    .insert(leads)
    .values({
      organizationId: orgId,
      firstName: "Priya",
      lastName: "Raman",
      email: `priya-${randomUUID().slice(0, 8)}@example.test`,
      phone: "+15550111",
      source: "direct",
      practiceAreaId,
    })
    .returning();
  leadId = lead!.id;

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

      const split = trustFirstSplit(600, 500, 1500);
      checkEqual("trust is filled first", split.trust, 600);
      checkEqual("operating gets nothing until trust is covered", split.operating, 0);
      checkEqual(
        "the split sums exactly",
        toMoney(split.operating + split.trust),
        600,
      );
      // The case that proves it is trust-FIRST rather than trust-only.
      const spill = trustFirstSplit(1000, 900, 400);
      checkEqual("it spills into operating once trust is covered", spill.operating, 600);
      checkEqual("with trust capped at what it owed", spill.trust, 400);

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

      // Ordered explicitly: once a provider payment writes one row per credited
      // leg there can be several rows here, and an unordered select would pick
      // an arbitrary one.
      const storedRows = await systemDb
        .select({
          operating: invoicePayments.amountOperating,
          trust: invoicePayments.amountTrust,
          amount: invoicePayments.amount,
        })
        .from(invoicePayments)
        .where(eq(invoicePayments.invoiceId, invoice.id))
        .orderBy(invoicePayments.createdAt);

      checkEqual("one row per recorded payment so far", storedRows.length, 1);
      const storedSplit = storedRows[0];
      // 940 against 1440 owed to trust: trust-first takes all of it.
      checkEqual(
        "trust share is stored, not inferred",
        Number(storedSplit!.trust),
        940,
      );
      checkEqual(
        "and operating gets nothing while trust is still owed",
        Number(storedSplit!.operating),
        0,
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

      // ── Extending a due date ──────────────────────────────────────────────
      section("extending a due date");

      // `second` is sent and partly paid — the shape the action exists for, and
      // the one a bare status === 'unpaid' check would have missed.
      const [beforeExtend] = await systemDb
        .select({ dueDate: invoices.dueDate, status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, second.id));
      const extendedTo = daysFromNow(45);

      const extended = await invoicesService.extendDueDate(
        orgId,
        second.id,
        { dueDate: extendedTo, reason: "Client asked for another fortnight" },
        staffBId,
        FULL,
      );
      checkEqual("the due date moves", extended.dueDate, extendedTo);
      checkEqual(
        "and the invoice keeps its status",
        extended.storedStatus,
        beforeExtend!.status,
      );

      // The column now holds the new date, so the trail is the only place the
      // old one survives. An audit that cannot say what changed is not one.
      //
      // finance_events had title + description as two columns; audit_events
      // renders the sentence into `summary` and keeps the structured detail in
      // `metadata`. Both halves are still asserted, they just live in different
      // places now — and they read from metadata rather than summary because
      // that is where `description` actually goes.
      const [extendEvent] = await systemDb
        .select({
          summary: auditEvents.summary,
          description: sql<string | null>`(${auditEvents.metadata}->>'description')`,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.entityId, second.id),
            like(auditEvents.summary, "%due date extended%"),
          ),
        );
      check("the extension is recorded", extendEvent != null);
      check(
        "with the date it moved from",
        extendEvent?.description?.includes(beforeExtend!.dueDate) ?? false,
        extendEvent?.description ?? "(no description recorded)",
      );
      check(
        "and the reason given",
        extendEvent?.description?.includes("another fortnight") ?? false,
        extendEvent?.description ?? "(no description recorded)",
      );

      // Forward only. This is the whole reason it is not just a PATCH.
      let backwardsRefused = false;
      try {
        await invoicesService.extendDueDate(
          orgId,
          second.id,
          { dueDate: daysFromNow(1) },
          staffBId,
          FULL,
        );
      } catch {
        backwardsRefused = true;
      }
      check("moving a due date backwards is refused", backwardsRefused);

      let sameDateRefused = false;
      try {
        await invoicesService.extendDueDate(
          orgId,
          second.id,
          { dueDate: extendedTo },
          staffBId,
          FULL,
        );
      } catch {
        sameDateRefused = true;
      }
      check("and so is the date it already has", sameDateRefused);

      // ── Scheduled invoices move the NEXT UNPAID instalment ────────────────
      //
      // The header date is pinned to the FINAL instalment, so it is not what
      // anyone means by "extend this". A client who missed instalment 1 of 3
      // needs longer on instalment 1 — and `dueBy` agrees, since a scheduled
      // invoice goes overdue on its next unpaid slice, never on its last.
      //
      // Sent, not a draft: the draft guard fires first and would make these
      // pass for the wrong reason.
      const scheduledInvoice = await invoicesService.create(
        orgId,
        staffBId,
        FULL,
        {
          clientId,
          caseId,
          issueDate: daysFromNow(-40),
          dueDate: daysFromNow(60),
          status: "draft",
          timeEntryIds: [],
          lineItems: [
            { description: "Scheduled work", quantity: 1, rate: 600, account: "operating" },
          ],
        },
      );
      await instalmentsService.setSchedule(
        orgId,
        scheduledInvoice.id,
        [
          // Already past — the case this whole feature exists for.
          { dueDate: daysFromNow(-10), amount: 200 },
          { dueDate: daysFromNow(30), amount: 200 },
          { dueDate: daysFromNow(60), amount: 200 },
        ],
        staffBId,
        FULL,
      );
      await systemDb
        .update(invoices)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(invoices.id, scheduledInvoice.id));

      const [beforeShift] = await systemDb
        .select({ dueDate: invoices.dueDate, nextDue: invoices.nextDueDate })
        .from(invoices)
        .where(eq(invoices.id, scheduledInvoice.id));
      checkEqual(
        "the header date is the final instalment",
        beforeShift!.dueDate,
        daysFromNow(60),
      );
      checkEqual(
        "and the invoice is next owed on the overdue slice",
        beforeShift!.nextDue,
        daysFromNow(-10),
      );

      const shifted = await invoicesService.extendDueDate(
        orgId,
        scheduledInvoice.id,
        { dueDate: daysFromNow(20), reason: "Missed the first payment" },
        staffBId,
        FULL,
      );
      const shiftedFirst = shifted.instalments.find((i) => i.sequence === 1);
      checkEqual(
        "the overdue instalment moves",
        shiftedFirst?.dueDate,
        daysFromNow(20),
      );
      checkEqual(
        "the header date is untouched — it follows the LAST instalment",
        shifted.dueDate,
        daysFromNow(60),
      );
      const [afterShift] = await systemDb
        .select({ nextDue: invoices.nextDueDate })
        .from(invoices)
        .where(eq(invoices.id, scheduledInvoice.id));
      checkEqual(
        "and next_due_date follows it, which is what clears the overdue flag",
        afterShift!.nextDue,
        daysFromNow(20),
      );
      checkEqual(
        "the schedule still sums to the total",
        shifted.instalments.reduce((sum, i) => sum + i.amount, 0),
        shifted.totals.total,
      );

      // Reordering the plan is a reschedule, not an extension.
      let reorderRefused = false;
      try {
        await invoicesService.extendDueDate(
          orgId,
          scheduledInvoice.id,
          { dueDate: daysFromNow(45) },
          staffBId,
          FULL,
        );
      } catch {
        reorderRefused = true;
      }
      check(
        "pushing an instalment past the next one is refused",
        reorderRefused,
      );

      // Landing exactly on the next instalment's date leaves two slices due the
      // same day with nothing deciding their order.
      let collisionRefused = false;
      try {
        await invoicesService.extendDueDate(
          orgId,
          scheduledInvoice.id,
          { dueDate: daysFromNow(30) },
          staffBId,
          FULL,
        );
      } catch {
        collisionRefused = true;
      }
      check(
        "and so is landing exactly on it",
        collisionRefused,
      );

      // The last instalment has nothing to collide with, and the header date
      // travels with it.
      await paymentsService.recordPayment(
        orgId,
        scheduledInvoice.id,
        staffBId,
        FULL,
        {
          amount: 400,
          paymentDate: daysFromNow(0),
          method: "bank_transfer",
        },
      );
      const lastExtended = await invoicesService.extendDueDate(
        orgId,
        scheduledInvoice.id,
        { dueDate: daysFromNow(90) },
        staffBId,
        FULL,
      );
      checkEqual(
        "extending the final instalment carries the header date with it",
        lastExtended.dueDate,
        daysFromNow(90),
      );

      // ── Void ──────────────────────────────────────────────────────────────
      section("voiding");

      // `invoice` was paid in full above. Voiding it would drop `collected` by
      // money the firm actually holds while the invoice_payments rows survive,
      // and there is no reversing entry to undo that with — the amount_positive
      // check constraint forbids a negative payment. So it is refused.
      let paidVoidRefused = false;
      try {
        await invoicesService.voidInvoice(
          orgId,
          invoice.id,
          "Issued in error",
          staffBId,
          FULL,
        );
      } catch {
        paidVoidRefused = true;
      }
      check("a paid invoice cannot be voided", paidVoidRefused);

      const statsBeforeVoid = await invoicesService.getStats(orgId, FULL);

      // A fresh, unpaid, countable invoice to void for real. It bills its own
      // time entry, so the release assertion below still means something —
      // `backdated` and `recent` are permanently attached to `invoice`, which
      // can no longer be voided.
      const voidableEntry = await timeBilling.create(orgId, staffAId, false, {
        staffId: staffAId,
        caseId,
        entryDate: "2026-06-14",
        hoursWorked: 1,
        description: "Work billed on an invoice that gets withdrawn",
        billable: true,
      });
      await timeBilling.approve(orgId, voidableEntry.id, staffBId);

      const toVoid = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(0),
        dueDate: daysFromNow(30),
        status: "draft",
        lineItems: [],
        timeEntryIds: [voidableEntry.id],
      });
      // Countable — a draft is excluded from the tiles anyway, so voiding one
      // would prove nothing about the revenue figures.
      await systemDb
        .update(invoices)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(invoices.id, toVoid.id));

      const statsWhileLive = await invoicesService.getStats(orgId, FULL);
      checkEqual(
        "a sent invoice counts toward revenue",
        statsWhileLive.totalInvoiced,
        statsBeforeVoid.totalInvoiced + toVoid.totals.total,
      );

      const voided = await invoicesService.voidInvoice(
        orgId,
        toVoid.id,
        "Issued in error",
        staffBId,
        FULL,
      );
      checkEqual("an unpaid invoice can be voided", voided.status, "void");

      const [releasedEntry] = await systemDb
        .select({ invoicedAt: timeEntries.invoicedAt })
        .from(timeEntries)
        .where(eq(timeEntries.id, voidableEntry.id));
      checkEqual(
        "its time entry can be billed again",
        releasedEntry?.invoicedAt ?? null,
        null,
      );

      // Relative, not the absolute 300 this used to assert: that literal was
      // only correct while this section voided the paid invoice, which is now
      // refused. "Voiding removes exactly what it added" is the real invariant
      // and does not go stale when an earlier section changes.
      const statsAfterVoid = await invoicesService.getStats(orgId, FULL);
      checkEqual(
        "a voided invoice leaves the revenue figures",
        statsAfterVoid.totalInvoiced,
        statsBeforeVoid.totalInvoiced,
      );
      checkEqual(
        "and the paid one it could not void is still counted",
        statsAfterVoid.collected > 0,
        true,
      );

      let doubleVoidRefused = false;
      try {
        await invoicesService.voidInvoice(orgId, toVoid.id, undefined, staffBId, FULL);
      } catch {
        doubleVoidRefused = true;
      }
      check("and cannot be voided twice", doubleVoidRefused);

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

      // Two entries of this section's own. This used to reuse `backdated` and
      // `recent`, relying on the void above having released them — a hidden
      // coupling that broke the moment voiding a paid invoice became refused.
      // Owning its fixtures keeps this section about draft editing.
      const swapOut = await timeBilling.create(orgId, staffAId, false, {
        staffId: staffAId,
        caseId,
        entryDate: "2026-06-16",
        hoursWorked: 2,
        description: "Entry the draft starts with",
        billable: true,
      });
      const swapIn = await timeBilling.create(orgId, staffAId, false, {
        staffId: staffAId,
        caseId,
        entryDate: "2026-06-17",
        hoursWorked: 1,
        description: "Entry the draft swaps to",
        billable: true,
      });
      await timeBilling.approve(orgId, swapOut.id, staffBId);
      await timeBilling.approve(orgId, swapIn.id, staffBId);

      const draft = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(0),
        dueDate: daysFromNow(30),
        status: "draft",
        lineItems: [
          { description: "Consultation", quantity: 1, rate: 100, account: "operating" },
        ],
        timeEntryIds: [swapOut.id],
      });
      const foldedTimeAmount = draft.totals.total - 100;
      check("the draft folds in its time entry", foldedTimeAmount > 0);

      const edited = await invoicesService.update(
        orgId,
        draft.id,
        {
          notes: "Revised before sending",
          lineItems: [
            { description: "Consultation", quantity: 2, rate: 100, account: "operating" },
          ],
          // Swap which time entry it bills.
          timeEntryIds: [swapIn.id],
        },
        staffBId,
        FULL,
      );
      checkEqual("the edit keeps the invoice number", edited.invoiceNumber, draft.invoiceNumber);
      checkEqual("it is still a draft", edited.status, "draft");
      checkEqual("the notes stuck", edited.notes, "Revised before sending");
      checkEqual("the line set was replaced", edited.lineItems.length, 2);

      const [swapOutAfter] = await systemDb
        .select({ invoicedAt: timeEntries.invoicedAt })
        .from(timeEntries)
        .where(eq(timeEntries.id, swapOut.id));
      const [swapInAfter] = await systemDb
        .select({ invoicedAt: timeEntries.invoicedAt })
        .from(timeEntries)
        .where(eq(timeEntries.id, swapIn.id));
      // The dropped entry must become billable again, or the work is stranded.
      checkEqual("the dropped entry is released", swapOutAfter?.invoicedAt ?? null, null);
      check("the added entry is claimed", swapInAfter?.invoicedAt != null);

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
          timeEntryIds: [swapIn.id],
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
        offered.some((e) => e.id === swapIn.id),
      );
      const unbilledOnly = await invoicesService.getUnbilledTime(orgId, { clientId });
      check(
        "but not to a plain unbilled query",
        !unbilledOnly.some((e) => e.id === swapIn.id),
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

      // A draft's schedule reaches nobody: the client has not been sent the
      // invoice, so there is no plan to notify them about yet.
      const draftDeliveries = await systemDb
        .select({ id: invoiceDeliveries.id })
        .from(invoiceDeliveries)
        .where(eq(invoiceDeliveries.invoiceId, planned.id));
      checkEqual(
        "scheduling a draft notifies nobody",
        draftDeliveries.length,
        0,
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

      // The list summary comes from its own query, never a join — a join would
      // duplicate rows on the page and inflate the count that drives pagination.
      const listed = await invoicesService.list(orgId, FULL, { status: "all" });
      const plannedRowInList = listed.data.find((r) => r.id === planned.id);
      checkEqual(
        "the list reports the schedule size",
        plannedRowInList?.schedule?.count,
        3,
      );
      checkEqual(
        "and how many instalments are settled",
        plannedRowInList?.schedule?.paidCount,
        1,
      );
      checkEqual(
        "and which one is next",
        plannedRowInList?.schedule?.nextDueDate,
        daysFromNow(-40),
      );
      checkEqual(
        "an unscheduled invoice reports no schedule",
        listed.data.find((r) => r.id === second.id)?.schedule,
        null,
      );
      // One row per invoice: a fan-out join would have duplicated `planned`.
      checkEqual(
        "the page has one row per invoice",
        listed.data.filter((r) => r.id === planned.id).length,
        1,
      );

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

      // The client holds this invoice, so a changed plan has to reach them.
      // Recorded as its own delivery kind, with the regenerated PDF archived.
      const scheduleSends = await systemDb
        .select({
          kind: invoiceDeliveries.kind,
          status: invoiceDeliveries.status,
          documentKey: invoiceDeliveries.documentKey,
          recipientEmail: invoiceDeliveries.recipientEmail,
        })
        .from(invoiceDeliveries)
        .where(
          and(
            eq(invoiceDeliveries.invoiceId, planned.id),
            eq(invoiceDeliveries.kind, "schedule_update"),
          ),
        );
      checkEqual("revising notifies the client", scheduleSends.length, 1);
      checkEqual(
        "at the address on file",
        scheduleSends[0]?.recipientEmail,
        CLIENT_EMAIL,
      );
      check(
        "with the revised invoice archived",
        Boolean(scheduleSends[0]?.documentKey),
      );

      // A schedule email proves the client received something, not that they
      // ever got the bill, so it must not unlock chasing on its own. `sentAt`
      // is cleared for the length of this assertion because it would otherwise
      // satisfy the legacy allowance and the check would pass without ever
      // exercising the kind filter.
      await systemDb
        .update(invoices)
        .set({ sentAt: null })
        .where(eq(invoices.id, planned.id));
      const chaseOnScheduleOnly = await deliveriesService.canChaseInvoice(
        orgId,
        planned.id,
      );
      await systemDb
        .update(invoices)
        .set({ sentAt: new Date() })
        .where(eq(invoices.id, planned.id));
      checkEqual(
        "a schedule email is not evidence the invoice arrived",
        chaseOnScheduleOnly,
        false,
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
          FULL,
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

      // ── Billing a lead ────────────────────────────────────────────────────
      section("billing a lead");

      const leadInvoice = await invoicesService.create(orgId, staffBId, FULL, {
        leadId,
        practiceAreaId,
        issueDate: daysFromNow(0),
        dueDate: daysFromNow(14),
        status: "draft",
        lineItems: [
          { description: "Consultation", quantity: 1, rate: 250, account: "operating" },
        ],
        timeEntryIds: [],
      });
      checkEqual("an invoice can bill a lead", leadInvoice.party.type, "lead");
      checkEqual(
        "named from the lead record",
        leadInvoice.party.name,
        "Priya Raman",
      );
      checkEqual(
        "and reports no client",
        leadInvoice.client,
        null,
      );

      // An inner join on clients would silently drop this row rather than
      // erroring — the failure this change could most easily have shipped with.
      const withLeadRows = await invoicesService.list(orgId, FULL, {
        status: "all",
        includeDrafts: true,
      });
      check(
        "a lead-billed invoice appears in the list",
        withLeadRows.data.some((r) => r.id === leadInvoice.id),
      );
      check(
        "and is findable by the lead's name",
        (
          await invoicesService.list(orgId, FULL, {
            status: "all",
            includeDrafts: true,
            search: "Raman",
          })
        ).data.some((r) => r.id === leadInvoice.id),
      );

      // The check constraint is the only place "exactly one party" can be
      // guaranteed, so it is worth proving it actually fires.
      let bothPartiesRejected = false;
      try {
        await systemDb
          .update(invoices)
          .set({ clientId })
          .where(eq(invoices.id, leadInvoice.id));
      } catch {
        bothPartiesRejected = true;
      }
      check("an invoice cannot bill both parties", bothPartiesRejected);

      let noPartyRejected = false;
      try {
        await systemDb
          .update(invoices)
          .set({ leadId: null })
          .where(eq(invoices.id, leadInvoice.id));
      } catch {
        noPartyRejected = true;
      }
      check("nor neither", noPartyRejected);

      // What openCase does on conversion.
      await systemDb
        .update(invoices)
        .set({ clientId, leadId: null })
        .where(eq(invoices.id, leadInvoice.id));
      const repointed = await invoicesService.getById(orgId, leadInvoice.id, FULL);
      checkEqual("repointing moves it to the client", repointed.party.type, "client");
      checkEqual("with the client's name", repointed.party.name, "Amara Chen");

      // ── Fee agreement billing ─────────────────────────────────────────────
      section("fee agreement billing");

      // Government fees are the client's money on its way to an agency, so they
      // belong in trust. Everything else is the firm's income.
      const feeLines = feeAgreementBilling.linesFromDocument([
        { description: "Legal services", amount: 2000, kind: "fee" },
        { description: "USCIS filing fee", amount: 675, kind: "government" },
        { description: "Courier", amount: 40, kind: "cost" },
        // Deferred: the firm is advancing it, so nobody owes it today.
        { description: "Expert report — advanced by firm", amount: 500, kind: "cost", deferred: true },
        // Pure contingency: no amount at all.
        { description: "Contingency — 33%", amount: null, kind: "fee", deferred: true },
      ]);
      checkEqual("only billable lines are invoiced", feeLines.length, 3);
      checkEqual(
        "government fees go to trust",
        feeLines.find((l) => l.description.includes("USCIS"))?.account,
        "trust_iolta",
      );
      checkEqual(
        "attorney fees go to operating",
        feeLines.find((l) => l.description === "Legal services")?.account,
        "operating",
      );
      checkEqual(
        "other costs go to operating",
        feeLines.find((l) => l.description === "Courier")?.account,
        "operating",
      );

      // The wizard lets an attorney promise 3 x 333.33 against a 1000 total.
      // The plan's shape is honoured; the amounts are recomputed so they sum.
      const planRows = feeAgreementBilling.scheduleFromPlan(
        1000,
        "installments",
        null,
        { numberOfPayments: 3, firstPaymentDate: "2026-09-01" },
        "2026-08-15",
      );
      checkEqual("an instalment plan becomes a schedule", planRows?.length, 3);
      checkEqual(
        "whose amounts sum to the total exactly",
        toMoney((planRows ?? []).reduce((s, r) => s + r.amount, 0)),
        1000,
      );

      const twoRows = feeAgreementBilling.scheduleFromPlan(
        1500,
        "two_payments",
        { firstAmount: 500, secondDueDate: "2026-10-01" },
        null,
        "2026-08-15",
      );
      checkEqual("two payments become two instalments", twoRows?.length, 2);
      checkEqual(
        "the first falls on the signing date",
        twoRows?.[0]?.dueDate,
        "2026-08-15",
      );
      checkEqual(
        "and the second carries the remainder",
        twoRows?.[1]?.amount,
        1000,
      );
      checkEqual(
        "pay in full needs no schedule",
        feeAgreementBilling.scheduleFromPlan(1000, "pay_in_full", null, null, "2026-08-15"),
        null,
      );

      // ── The case-opening gate ─────────────────────────────────────────────
      section("case-opening gate");

      checkEqual(
        "no invoice means nothing to satisfy",
        await feeAgreementBilling.feeInvoiceSatisfied(orgId, null),
        true,
      );

      const gateInvoice = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(-10),
        dueDate: daysFromNow(60),
        status: "draft",
        lineItems: [
          { description: "Retainer", quantity: 1, rate: 4000, account: "operating" },
        ],
        timeEntryIds: [],
      });
      await invoicesService.update(
        orgId,
        gateInvoice.id,
        {
          instalments: [
            { dueDate: daysFromNow(-5), amount: 1000 },
            { dueDate: daysFromNow(25), amount: 1000 },
            { dueDate: daysFromNow(55), amount: 1000 },
            { dueDate: daysFromNow(60), amount: 1000 },
          ],
        },
        staffBId,
        FULL,
      );
      // A draft has not been sent, so the client has not been asked.
      checkEqual(
        "a draft invoice does not block the case",
        await feeAgreementBilling.feeInvoiceSatisfied(orgId, gateInvoice.id),
        true,
      );

      await systemDb
        .update(invoices)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(invoices.id, gateInvoice.id));
      checkEqual(
        "an unpaid deposit does block it",
        await feeAgreementBilling.feeInvoiceSatisfied(orgId, gateInvoice.id),
        false,
      );

      await paymentsService.recordPayment(orgId, gateInvoice.id, staffBId, FULL, {
        amount: 1000,
        paymentDate: daysFromNow(-4),
        method: "bank_transfer",
      });
      // The whole point of allowing a plan: the deposit opens the case, the
      // remaining three payments are not yet due.
      checkEqual(
        "a paid deposit opens it with nothing overdue",
        await feeAgreementBilling.feeInvoiceSatisfied(orgId, gateInvoice.id),
        true,
      );

      await instalmentsService.setSchedule(
        orgId,
        gateInvoice.id,
        [
          { dueDate: daysFromNow(-5), amount: 1000 },
          { dueDate: daysFromNow(-2), amount: 1000 },
          { dueDate: daysFromNow(55), amount: 1000 },
          { dueDate: daysFromNow(60), amount: 1000 },
        ],
        staffBId,
        FULL,
      );
      checkEqual(
        "a missed instalment blocks it again",
        await feeAgreementBilling.feeInvoiceSatisfied(orgId, gateInvoice.id),
        false,
      );

      // ── Payment provider seam ─────────────────────────────────────────────
      section("payment readiness");

      // Readiness is per ORGANIZATION now, not per deployment. This org has no
      // confido_firms row, so it cannot take money — and every path that could
      // has to say so rather than pretend.
      checkEqual(
        "an org with no Confido account cannot take payments",
        await paymentsEnabledFor(orgId),
        false,
      );

      // The refusal must come from readiness, not from an unrelated failure. A
      // check that passes because the token was bogus proves nothing, which is
      // what the previous version of this section did once a provider existed.
      const readyInvoiceToken = await paymentLinks.mintPaymentLink(
        orgId,
        second.id,
      );
      let unreadyCheckoutRefused = false;
      let refusalMessage = "";
      try {
        await paymentLinks.startCheckout(readyInvoiceToken);
      } catch (err) {
        unreadyCheckoutRefused = true;
        refusalMessage = err instanceof Error ? err.message : "";
      }
      check("checkout is refused for an unready firm", unreadyCheckoutRefused);
      check(
        "and refused for the right reason",
        refusalMessage.includes("not available yet"),
        refusalMessage,
      );

      section("payment links");

      const linkToken = await paymentLinks.mintPaymentLink(orgId, second.id);
      const payable = await paymentLinks.invoiceByPaymentToken(linkToken);
      checkEqual("a link resolves its invoice", payable.invoiceId, second.id);
      checkEqual(
        "and reports payment unavailable",
        payable.paymentsEnabled,
        false,
      );

      // Rotation is the price of storing only the hash: there is no way to
      // resend the old link, so minting a new one has to retire it.
      const rotated = await paymentLinks.mintPaymentLink(orgId, second.id);
      check("re-minting produces a different token", rotated !== linkToken);
      let staleTokenRejected = false;
      try {
        await paymentLinks.invoiceByPaymentToken(linkToken);
      } catch {
        staleTokenRejected = true;
      }
      check("and the previous one stops working", staleTokenRejected);

      let unknownTokenRejected = false;
      try {
        await paymentLinks.invoiceByPaymentToken("not-a-real-token");
      } catch {
        unknownTokenRejected = true;
      }
      check("an unknown token is refused", unknownTokenRejected);

      // A settled invoice still RESOLVES — the page polls this while a card is
      // processing, and throwing the moment the balance clears would flip it
      // into an error at the instant of success. Taking money against one is
      // what must be refused.
      //
      // `invoice` here was paid in full earlier and then voided, so it is
      // refused on both counts; the void check fires first.
      const paidToken = await paymentLinks.mintPaymentLink(orgId, invoice.id);
      let settledCheckoutRejected = false;
      try {
        await paymentLinks.startCheckout(paidToken);
      } catch {
        settledCheckoutRejected = true;
      }
      check("a settled invoice cannot be paid again", settledCheckoutRejected);

      // ── Ledger idempotency ────────────────────────────────────────────────
      section("ledger idempotency");

      // The provision that is genuinely painful to retrofit: a redelivered
      // webhook must hit a constraint rather than record the same money twice.
      await systemDb.insert(invoicePayments).values({
        organizationId: orgId,
        invoiceId: second.id,
        amount: "10.00",
        amountOperating: "10.00",
        amountTrust: "0.00",
        paymentDate: daysFromNow(0),
        method: "credit_card",
        provider: "stripe",
        providerReference: "pi_check_duplicate",
      });

      let duplicatePaymentRejected = false;
      try {
        await systemDb.insert(invoicePayments).values({
          organizationId: orgId,
          invoiceId: second.id,
          amount: "10.00",
          amountOperating: "10.00",
          amountTrust: "0.00",
          paymentDate: daysFromNow(0),
          method: "credit_card",
          provider: "stripe",
          providerReference: "pi_check_duplicate",
        });
      } catch {
        duplicatePaymentRejected = true;
      }
      check(
        "the same provider payment cannot be recorded twice",
        duplicatePaymentRejected,
      );

      // Hand-entered rows leave both columns null and must stay unaffected —
      // otherwise the index would stop staff recording two cash payments.
      await systemDb.insert(invoicePayments).values([
        {
          organizationId: orgId,
          invoiceId: second.id,
          amount: "5.00",
          amountOperating: "5.00",
          amountTrust: "0.00",
          paymentDate: daysFromNow(0),
          method: "cash",
        },
        {
          organizationId: orgId,
          invoiceId: second.id,
          amount: "5.00",
          amountOperating: "5.00",
          amountTrust: "0.00",
          paymentDate: daysFromNow(0),
          method: "cash",
        },
      ]);
      check("but two manual payments still can be", true);

      // The event store is the first line of defence, and it has to be its own
      // mechanism: signing has a terminal state to guard on, payments do not.
      await systemDb.insert(paymentWebhookEvents).values({
        provider: "stripe",
        eventId: "evt_check_1",
        eventType: "payment",
      });
      let duplicateEventRejected = false;
      try {
        await systemDb.insert(paymentWebhookEvents).values({
          provider: "stripe",
          eventId: "evt_check_1",
          eventType: "payment",
        });
      } catch {
        duplicateEventRejected = true;
      }
      check("a replayed event id is rejected", duplicateEventRejected);

      // ── Line preset catalog ───────────────────────────────────────────────
      // Placed here deliberately: the money assertions earlier in this file are
      // chained and absolute (totalInvoiced 2240, statsAfterVoid 300), so the
      // invoice this section raises must come after all of them.
      section("line preset catalog");

      // Shipped rows are written with systemDb because RLS forbids a tenant
      // from creating one — which is itself asserted below.
      const [shippedGeneral] = await systemDb
        .insert(invoiceLinePresets)
        .values({
          organizationId: null,
          name: "Check — postage",
          account: "operating",
          defaultRate: "12.0000",
        })
        .returning();
      const [shippedArea] = await systemDb
        .insert(invoiceLinePresets)
        .values({
          organizationId: null,
          name: "Check — area filing fee",
          account: "trust_iolta",
          defaultRate: "405.0000",
          practiceAreaId,
        })
        .returning();
      const [shippedCaseType] = await systemDb
        .insert(invoiceLinePresets)
        .values({
          organizationId: null,
          name: "Check — I-485 filing fee",
          account: "trust_iolta",
          defaultRate: "1440.0000",
          practiceAreaId,
          caseTypeId: caseType!.id,
        })
        .returning();
      const [shippedToShadow] = await systemDb
        .insert(invoiceLinePresets)
        .values({
          organizationId: null,
          name: "Check — superseded fee",
          account: "operating",
          defaultRate: "99.0000",
          practiceAreaId,
        })
        .returning();
      presetIdsToClean.push(
        shippedGeneral!.id,
        shippedArea!.id,
        shippedCaseType!.id,
        shippedToShadow!.id,
      );

      // A firm that has authored nothing still gets a working catalog. This
      // reads through the TENANT connection, so it is the RLS `using` clause
      // being exercised, not a bypass.
      const scoped = await linePresets.listPresets(orgId, FULL, {
        practiceAreaId,
        caseTypeId: caseType!.id,
      });
      const scopedNames = scoped.map((p) => p.name);
      check(
        "a firm with no presets of its own still sees the shipped catalog",
        scopedNames.includes("Check — postage") &&
          scopedNames.includes("Check — area filing fee") &&
          scopedNames.includes("Check — I-485 filing fee"),
        scopedNames,
      );
      checkEqual(
        "shipped rows report their origin",
        scoped.find((p) => p.name === "Check — postage")?.origin,
        "shipped",
      );

      // Most-specific first, so the picker's group headings come straight off
      // the response.
      const rankOf = (name: string) =>
        scoped.find((p) => p.name === name)?.rank;
      checkEqual("a case-type preset ranks as one", rankOf("Check — I-485 filing fee"), "case_type");
      checkEqual("a practice-area preset ranks as one", rankOf("Check — area filing fee"), "practice_area");
      checkEqual("an unscoped preset ranks general", rankOf("Check — postage"), "general");
      check(
        "and they arrive in that order",
        scoped.findIndex((p) => p.name === "Check — I-485 filing fee") <
          scoped.findIndex((p) => p.name === "Check — area filing fee") &&
          scoped.findIndex((p) => p.name === "Check — area filing fee") <
            scoped.findIndex((p) => p.name === "Check — postage"),
      );

      // Widening is one-directional: a narrower preset must not leak upward.
      const areaOnly = await linePresets.listPresets(orgId, FULL, {
        practiceAreaId,
      });
      check(
        "a case-type preset is withheld from a matter without that case type",
        !areaOnly.some((p) => p.name === "Check — I-485 filing fee"),
      );
      const unscopedOnly = await linePresets.listPresets(orgId, FULL, {});
      checkEqual(
        "an invoice with no matter sees only the general tier",
        unscopedOnly.every((p) => p.rank === "general"),
        true,
      );

      // Trust visibility. The list is a UX filter; the write path below is the
      // boundary that actually matters.
      const withoutTrust = await linePresets.listPresets(orgId, NO_TRUST, {
        practiceAreaId,
        caseTypeId: caseType!.id,
      });
      checkEqual(
        "a caller without trust access is shown no trust presets",
        withoutTrust.some((p) => p.account === "trust_iolta"),
        false,
      );
      check(
        "but still sees the operating ones",
        withoutTrust.some((p) => p.name === "Check — postage"),
      );

      // ── Saving a custom line ──────────────────────────────────────────────
      const savedFirst = await linePresets.saveFirmPreset(
        orgId,
        staffBId,
        FULL,
        {
          name: "Check — bespoke drafting",
          account: "operating",
          defaultRate: 400,
          practiceAreaId,
        },
      );
      presetIdsToClean.push(savedFirst.id);
      checkEqual("a saved custom line is firm-owned", savedFirst.origin, "firm");

      // Re-saving the same name is an update, not a duplicate and not an error.
      // It is the only way to correct an amount until the edit screen exists.
      const savedAgain = await linePresets.saveFirmPreset(
        orgId,
        staffBId,
        FULL,
        {
          name: "Check — bespoke drafting",
          account: "operating",
          defaultRate: 450,
          practiceAreaId,
        },
      );
      checkEqual("re-saving updates in place", savedAgain.id, savedFirst.id);
      checkEqual("and takes the newer amount", savedAgain.defaultRate, 450);

      const afterSave = await linePresets.listPresets(orgId, FULL, {
        practiceAreaId,
      });
      checkEqual(
        "the firm's list holds it exactly once",
        afterSave.filter((p) => p.name === "Check — bespoke drafting").length,
        1,
      );
      // A firm's own entry outranks the shipped rows it sits beside.
      check(
        "a firm entry sorts ahead of shipped ones at the same rank",
        afterSave.findIndex((p) => p.name === "Check — bespoke drafting") <
          afterSave.findIndex((p) => p.name === "Check — area filing fee"),
      );

      let trustPresetRefused = false;
      try {
        await linePresets.saveFirmPreset(orgId, staffBId, NO_TRUST, {
          name: "Check — forbidden trust line",
          account: "trust_iolta",
          defaultRate: 100,
        });
      } catch {
        trustPresetRefused = true;
      }
      check(
        "saving a trust preset without trust access is refused",
        trustPresetRefused,
      );

      // ── Shadowing ─────────────────────────────────────────────────────────
      const [shadowRow] = await systemDb
        .insert(invoiceLinePresets)
        .values({
          organizationId: orgId,
          shadowsPresetId: shippedToShadow!.id,
          name: "Check — superseded fee",
          account: "operating",
          defaultRate: "150.0000",
          practiceAreaId,
        })
        .returning();
      presetIdsToClean.push(shadowRow!.id);

      const afterShadow = await linePresets.listPresets(orgId, FULL, {
        practiceAreaId,
      });
      const supersededRows = afterShadow.filter(
        (p) => p.name === "Check — superseded fee",
      );
      checkEqual(
        "a shadowed shipped preset drops out of the list",
        supersededRows.length,
        1,
      );
      checkEqual(
        "leaving the firm's own in its place",
        supersededRows[0]?.defaultRate,
        150,
      );
      // The shipped row is untouched — that is the whole point of shadowing
      // rather than editing, and it is what lets a CLI correction still land.
      const [shippedStillThere] = await systemDb
        .select({ rate: invoiceLinePresets.defaultRate })
        .from(invoiceLinePresets)
        .where(eq(invoiceLinePresets.id, shippedToShadow!.id));
      checkEqual(
        "while the shipped row itself is unchanged",
        num(shippedStillThere!.rate),
        99,
      );

      // ── RLS on the shared catalog ─────────────────────────────────────────
      //
      // Asserted in `07-rls`, not here. That a firm cannot author a shipped
      // (NULL-organization) preset is an RLS property, and RLS is INERT on the
      // connection this check uses: `oravanti_admin` owns the table, so
      // policies do not apply to it and the write simply succeeds. `07-rls`
      // connects as `oravanti_rls_probe` — non-superuser, non-owner, no
      // BYPASSRLS — which is the only way to demonstrate the policy at all.
      //
      // This check previously tried to assert it through `db` and therefore
      // failed on any clean database, "passing" only when a leftover row from
      // an earlier failed run tripped the unique index instead. It also leaked
      // that row: inserted without `.returning()`, its id never reached
      // `presetIdsToClean`, so every failure left a NULL-organization preset —
      // a shipped catalog entry visible to every firm — behind.

      // ── Provenance on the line ────────────────────────────────────────────
      const presetInvoice = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(0),
        dueDate: daysFromNow(30),
        status: "draft",
        timeEntryIds: [],
        lineItems: [
          {
            description: "Check — postage",
            quantity: 1,
            rate: 12,
            account: "operating",
            presetId: shippedGeneral!.id,
          },
        ],
      });
      const presetLine = presetInvoice.lineItems[0];
      checkEqual(
        "a line composed from a preset records which one",
        presetLine?.presetId,
        shippedGeneral!.id,
      );

      // Retiring a preset must not reach into an invoice the client holds. This
      // is why the reference is `set null` and why the rate is copied, never
      // read back.
      await systemDb
        .delete(invoiceLinePresets)
        .where(eq(invoiceLinePresets.id, shippedGeneral!.id));
      const [orphaned] = await systemDb
        .select({
          description: invoiceLineItems.description,
          rate: invoiceLineItems.rate,
          presetId: invoiceLineItems.presetId,
        })
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.id, presetLine!.id));
      checkEqual(
        "deleting the preset leaves the billed description intact",
        orphaned!.description,
        "Check — postage",
      );
      checkEqual(
        "and the billed rate intact",
        num(orphaned!.rate),
        12,
      );
      checkEqual(
        "clearing only the provenance link",
        orphaned!.presetId,
        null,
      );

      // ── Activity trail ────────────────────────────────────────────────────
      section("reversals");

      // Raised here, after every absolute money assertion above, for the same
      // reason the preset section is: this invoice's payments must not move
      // the running totals those depend on.
      const refundable = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(-3),
        dueDate: daysFromNow(30),
        status: "draft",
        lineItems: [
          { description: "USCIS filing fee", quantity: 1, rate: 1000, account: "trust_iolta" },
          { description: "Attorney time", quantity: 1, rate: 500, account: "operating" },
        ],
        timeEntryIds: [],
      });
      await systemDb
        .update(invoices)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(invoices.id, refundable.id));

      // Paid in full as a provider would report it: one single-sided row per
      // credited account, each with its own transaction id.
      await paymentsService.recordPayment(orgId, refundable.id, staffBId, FULL, {
        amount: 1500,
        paymentDate: daysFromNow(-1),
        method: "credit_card",
        provider: "confido",
        legs: [
          { account: "trust_iolta", amount: 1000, providerReference: "txn_rev_trust" },
          { account: "operating", amount: 500, providerReference: "txn_rev_op" },
        ],
      });

      const paidRow = async (id: string) => {
        const [row] = await systemDb
          .select({
            amountPaid: invoices.amountPaid,
            balanceDue: invoices.balanceDue,
            status: invoices.status,
          })
          .from(invoices)
          .where(eq(invoices.id, id));
        return row!;
      };

      const afterPaid = await paidRow(refundable.id);
      checkEqual("both legs land", Number(afterPaid.amountPaid), 1500);
      checkEqual("and settle the invoice", afterPaid.status, "paid");

      const trustLeg = await systemDb
        .select({ id: invoicePayments.id })
        .from(invoicePayments)
        .where(eq(invoicePayments.providerReference, "txn_rev_trust"));

      // A partial refund of the trust leg. THE invariant of the whole design:
      // a reversal must SUBTRACT, not add. Under a positive-rows-plus-kind
      // ledger a forgotten filter would read 1500 + 400 here.
      await paymentsService.recordReversal(orgId, refundable.id, staffBId, FULL, {
        kind: "refund",
        reversesPaymentId: trustLeg[0]!.id,
        amount: 400,
        account: "trust_iolta",
        paymentDate: daysFromNow(0),
        method: "credit_card",
        provider: "confido",
        providerReference: "txn_rev_refund_1",
      });

      const afterRefund = await paidRow(refundable.id);
      checkEqual("a refund reduces what was paid", Number(afterRefund.amountPaid), 1100);
      checkEqual("the balance reopens", Number(afterRefund.balanceDue), 400);
      checkEqual("and the invoice is no longer paid", afterRefund.status, "partial");

      // The trust figure Reports shows must net too — it sums amount_trust, and
      // client money that went back is not money the firm still holds.
      const [trustFold] = await systemDb
        .select({ trust: sql<string>`coalesce(sum(${invoicePayments.amountTrust}), 0)` })
        .from(invoicePayments)
        .where(eq(invoicePayments.invoiceId, refundable.id));
      checkEqual("the trust side nets the refund", Number(trustFold!.trust), 600);

      // Giving back more than came in. The unique index catches a replay of the
      // same reversal; this catches two distinct events describing one refund.
      let overReversed = false;
      try {
        await paymentsService.recordReversal(orgId, refundable.id, staffBId, FULL, {
          kind: "refund",
          reversesPaymentId: trustLeg[0]!.id,
          amount: 900,
          account: "trust_iolta",
          paymentDate: daysFromNow(0),
          method: "credit_card",
          provider: "confido",
          providerReference: "txn_rev_refund_2",
        });
      } catch {
        overReversed = true;
      }
      check("refunding past what remains is refused", overReversed);

      // Sign follows kind, enforced by the database rather than by the service
      // that happens to call it.
      let positiveReversalRejected = false;
      try {
        await systemDb.insert(invoicePayments).values({
          organizationId: orgId,
          invoiceId: refundable.id,
          kind: "refund",
          reversesPaymentId: trustLeg[0]!.id,
          amount: "50.00",
          amountOperating: "50.00",
          amountTrust: "0.00",
          paymentDate: daysFromNow(0),
          method: "other",
        });
      } catch {
        positiveReversalRejected = true;
      }
      check("a positive reversal row is rejected by the constraint", positiveReversalRejected);

      let unlinkedReversalRejected = false;
      try {
        await systemDb.insert(invoicePayments).values({
          organizationId: orgId,
          invoiceId: refundable.id,
          kind: "refund",
          amount: "-50.00",
          amountOperating: "-50.00",
          amountTrust: "0.00",
          paymentDate: daysFromNow(0),
          method: "other",
        });
      } catch {
        unlinkedReversalRejected = true;
      }
      check("a reversal pointing at nothing is rejected too", unlinkedReversalRejected);

      section("clearing policy");

      // A card payment reported but not deposited. Which policy the firm is on
      // decides whether it can open a case.
      const clearing = await invoicesService.create(orgId, staffBId, FULL, {
        clientId,
        caseId,
        issueDate: daysFromNow(-3),
        dueDate: daysFromNow(30),
        status: "draft",
        lineItems: [
          { description: "Deposit", quantity: 1, rate: 800, account: "operating" },
        ],
        timeEntryIds: [],
      });
      await systemDb
        .update(invoices)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(invoices.id, clearing.id));

      await paymentsService.recordPayment(orgId, clearing.id, staffBId, FULL, {
        amount: 800,
        paymentDate: daysFromNow(0),
        method: "credit_card",
        provider: "confido",
        settledAt: null,
        providerStatus: "PENDING",
        legs: [{ account: "operating", amount: 800, providerReference: "txn_pending_card" }],
      });

      const gateUnder = async (policy: "on_report" | "ach_only" | "all_payments") => {
        await systemDb
          .insert(confidoFirms)
          .values({
            organizationId: orgId,
            confidoFirmId: `firm-${orgId}`,
            status: "ACTIVE",
            isAcceptingPayments: true,
            provisioningState: "ready",
            paymentClearingPolicy: policy,
          })
          .onConflictDoUpdate({
            target: confidoFirms.organizationId,
            set: { paymentClearingPolicy: policy },
          });
        return feeAgreementBilling.feeInvoiceSatisfied(orgId, clearing.id);
      };

      checkEqual(
        "on_report opens a case on money merely reported",
        await gateUnder("on_report"),
        true,
      );
      checkEqual(
        "ach_only lets an unsettled CARD through",
        await gateUnder("ach_only"),
        true,
      );
      checkEqual(
        "all_payments holds it until the money clears",
        await gateUnder("all_payments"),
        false,
      );

      // HELD is Confido's risk review — "we are not sure this money is good" —
      // and must not pass even the permissive card rule.
      await systemDb
        .update(invoicePayments)
        .set({ providerStatus: "HELD" })
        .where(eq(invoicePayments.providerReference, "txn_pending_card"));
      checkEqual(
        "but a HELD card never counts, even under ach_only",
        await gateUnder("ach_only"),
        false,
      );

      await paymentsService.markPaymentSettled(
        orgId,
        "confido",
        "txn_pending_card",
        "DEPOSITED",
        true,
      );
      checkEqual(
        "once deposited it counts under every policy",
        await gateUnder("all_payments"),
        true,
      );

      section("activity trail");

      const events = await systemDb
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.organizationId, orgId));
      const types = new Set(events.map((e) => e.action));
      check("invoice creation is recorded", types.has("finance.invoice_sent"));
      check("payment is recorded", types.has("finance.invoice_partially_paid"));
      check("settlement is recorded", types.has("finance.invoice_paid"));
      check("follow-up is recorded", types.has("finance.payment_followup_sent"));
      check("void is recorded", types.has("finance.invoice_voided"));
      check("time approval is recorded", types.has("finance.time_entry_approved"));
      check("a schedule being set is recorded", types.has("finance.invoice_schedule_set"));
      check("a revision is recorded", types.has("finance.invoice_schedule_revised"));
      check("a removal is recorded", types.has("finance.invoice_schedule_removed"));
    });
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────
    // The clearing-policy section attaches a Confido firm to this org, and the
    // FK to `organization` is not cascading — deliberately, since a firm's
    // merchant account should outlive a careless delete.
    await systemDb
      .delete(confidoFirms)
      .where(eq(confidoFirms.organizationId, orgId));

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
    // Before the practice area, whose cascade would otherwise reach the scoped
    // ones and leave the unscoped shipped row behind.
    if (presetIdsToClean.length) {
      await systemDb
        .delete(invoiceLinePresets)
        .where(inArray(invoiceLinePresets.id, presetIdsToClean));
    }
    // Belt and braces for the shared catalog: anything NULL-organization this
    // check named, whether or not its id was captured. A leaked shipped preset
    // is visible to every firm, so it is worth sweeping by name rather than
    // trusting that every insert remembered to return its id.
    await systemDb
      .delete(invoiceLinePresets)
      .where(
        and(
          isNull(invoiceLinePresets.organizationId),
          like(invoiceLinePresets.name, "Check %"),
        ),
      );
    // Not org-scoped by design, so cleaned by the ids this check invents.
    await systemDb
      .delete(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.eventId, "evt_check_1"));
    await systemDb.delete(auditEvents).where(eq(auditEvents.organizationId, orgId));
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
    // After invoices: invoices.lead_id references leads with no cascade.
    await systemDb.delete(leads).where(eq(leads.organizationId, orgId));
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
