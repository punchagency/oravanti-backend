/**
 * Tier 1 — Postgres. The dashboard API the frontend consumes.
 *
 *   npm run check 10-case-review-api
 *
 * Covers what the UI actually reads: the enriched issue payload (case number,
 * practice area, category kicker), the stats strip, the by-case / by-document /
 * resolution-log views, and the contextual action registry.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { systemDb } from "../../src/db/client";
import { aiScanJobs } from "../../src/db/schema/ai-scan-jobs";
import {
  caseIssueDocuments,
  caseIssueEvents,
  caseIssues,
} from "../../src/db/schema/case-issues";
import { scenarioDocumentRequirements } from "../../src/db/schema/document-requirements";
import { calendarEvents } from "../../src/db/schema/calendar-events";
import { leadTasks } from "../../src/db/schema/lead-tasks";
import { CaseReviewService } from "../../src/modules/case-review/case-review.service";
import { renderCsv, renderPdf } from "../../src/utils/report-export";
import {
  check,
  checkEqual,
  report,
  section,
  withOrgContext,
  withTempFixture,
} from "./_bootstrap";

const service = new CaseReviewService();

const seedIssue = async (
  organizationId: string,
  leadId: string,
  overrides: Partial<typeof caseIssues.$inferInsert> = {},
) => {
  const [row] = await systemDb
    .insert(caseIssues)
    .values({
      organizationId,
      leadId,
      issueKey: `check-${Math.random().toString(36).slice(2, 10)}`,
      contentHash: "hash",
      issueType: "missing_required_document",
      source: "rule",
      ruleVersion: "1",
      severity: "critical",
      templateKey: "missing_required_document",
      templateParams: { label: "Passport" },
      ...overrides,
    })
    .returning();
  return row;
};

const main = async () => {
  await withTempFixture({ docs: [] }, async (fx) => {
    try {
      const issue = await seedIssue(fx.organizationId, fx.leadId);

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("issue payload — presentation fields");

        const page = await service.getIssues(fx.organizationId, {});
        const item = page.data.find((i: { id: string }) => i.id === issue.id) as
          | Record<string, unknown>
          | undefined;

        check("the seeded issue is listed", !!item);
        if (!item) return;

        checkEqual("issueType carried", item.issueType, "missing_required_document");
        checkEqual(
          "category kicker derived from issueType",
          item.category,
          "MISSING DOCUMENT",
        );
        checkEqual("badge derived from severity", item.badge, "critical");
        check("prose title rendered", typeof item.title === "string" && !!item.title, item.title);
        check(
          "description rendered",
          typeof item.description === "string",
          item.description,
        );

        const scenario = item.scenario as Record<string, unknown>;
        checkEqual("scenario type is lead", scenario.type, "lead");
        checkEqual("scenario id is the lead", scenario.id, fx.leadId);
        check(
          "a lead scenario falls back to the lead's name as its reference",
          typeof scenario.reference === "string" &&
            (scenario.reference as string).includes("Check"),
          scenario.reference,
        );

        check(
          "caseTypeName is present on the payload (null for a lead)",
          "caseTypeName" in item,
          Object.keys(item),
        );

        section("detail endpoint agrees with the list");

        const detail = (await service.getIssueById(
          fx.organizationId,
          issue.id,
        )) as Record<string, unknown>;

        checkEqual("same category", detail.category, item.category);
        checkEqual("same title", detail.title, item.title);
        checkEqual(
          "same scenario reference",
          (detail.scenario as Record<string, unknown>).reference,
          scenario.reference,
        );
        check("detail carries documents", Array.isArray(detail.documents));
        check("detail carries events", Array.isArray(detail.events));

        section("unknown issue types degrade rather than break");

        const odd = await seedIssue(fx.organizationId, fx.leadId, {
          issueType: "some_future_rule",
          templateKey: "some_future_rule",
        });
        const oddDetail = (await service.getIssueById(
          fx.organizationId,
          odd.id,
        )) as Record<string, unknown>;
        checkEqual(
          "category falls back to a humanised issueType",
          oddDetail.category,
          "SOME FUTURE RULE",
        );
        check(
          "prose falls back rather than throwing",
          typeof oddDetail.title === "string",
          oddDetail.title,
        );
      });
    } finally {
      await systemDb
        .delete(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
    }
  });

  // A case scenario is where caseNumber and the practice-area join actually
  // matter — leads fall back to their own name and exercise neither.
  await withTempFixture({ docs: [], withCase: true }, async (fx) => {
    try {
      const c = fx.case!;
      const issue = await seedIssue(fx.organizationId, fx.leadId, {
        leadId: null,
        caseId: c.caseId,
        clientId: c.clientId,
        issueType: "document_expiry_before_deadline",
        templateKey: "document_expiry_before_deadline",
        templateParams: { documentTitle: "Passport", deadline: "2026-06-22" },
      });

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("case scenario — reference, practice area, client");

        const detail = (await service.getIssueById(
          fx.organizationId,
          issue.id,
        )) as Record<string, unknown>;
        const scenario = detail.scenario as Record<string, unknown>;

        checkEqual("scenario type is case", scenario.type, "case");
        checkEqual("scenario id is the case", scenario.id, c.caseId);
        checkEqual(
          "reference is the case number",
          scenario.reference,
          c.caseNumber,
        );
        checkEqual(
          "caseTypeName resolved through the practice-area join",
          detail.caseTypeName,
          c.caseTypeName,
        );
        checkEqual("caseTypeId carried", detail.caseTypeId, c.caseTypeId);

        const client = detail.client as Record<string, unknown> | null;
        checkEqual("client id carried", client?.id, c.clientId);
        checkEqual("client display name carried", client?.name, c.clientName);

        checkEqual(
          "category for an expiry issue",
          detail.category,
          "DOCUMENT RISK",
        );

        section("the list endpoint presents a case identically");

        const page = await service.getIssues(fx.organizationId, {});
        const item = page.data.find(
          (i: { id: string }) => i.id === issue.id,
        ) as Record<string, unknown>;
        check("the case issue is listed", !!item);
        checkEqual(
          "same reference in the list",
          (item.scenario as Record<string, unknown>).reference,
          c.caseNumber,
        );
        checkEqual(
          "same practice area in the list",
          item.caseTypeName,
          c.caseTypeName,
        );
      });
    } finally {
      await systemDb
        .delete(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
    }
  });

  // ── Stats strip ───────────────────────────────────────────────────────────
  await withTempFixture({ docs: [], withCase: true }, async (fx) => {
    const c = fx.case!;
    const batchId = randomUUID();
    try {
      await seedIssue(fx.organizationId, fx.leadId, { severity: "critical" });
      await seedIssue(fx.organizationId, fx.leadId, { severity: "medium" });

      section("stats — tiles");

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        const stats = (await service.getStats(fx.organizationId)) as Record<
          string,
          unknown
        >;

        checkEqual("critical tile counts critical+high", stats.criticalIssues, 1);
        checkEqual("warnings tile counts medium+low", stats.warnings, 1);
        checkEqual("matters affected is distinct", stats.mattersAffected, 1);
        checkEqual(
          "total active matters is the denominator",
          stats.totalActiveMatters,
          1,
        );

        section("stats — last scan strip with no scan yet");

        const none = stats.lastScan as Record<string, unknown>;
        checkEqual("no scan reports a null timestamp", none.at, null);
        checkEqual("no scan reviewed nothing", none.mattersReviewed, 0);
        checkEqual("no scan found nothing", none.issuesFound, 0);
      });

      section("stats — last scan strip aggregates one batch");

      // Two completed jobs sharing a batch, plus an older unrelated job that
      // must not be counted in the run.
      const completedAt = new Date();
      await systemDb.insert(aiScanJobs).values([
        {
          organizationId: fx.organizationId,
          leadId: fx.leadId,
          status: "complete",
          trigger: "full_scan",
          batchId,
          documentCount: 1,
          issuesFound: 3,
          completedAt,
        },
        {
          organizationId: fx.organizationId,
          caseId: c.caseId,
          status: "complete",
          trigger: "full_scan",
          batchId,
          documentCount: 2,
          issuesFound: 4,
          completedAt: new Date(completedAt.getTime() - 1000),
        },
        {
          organizationId: fx.organizationId,
          leadId: fx.leadId,
          status: "complete",
          trigger: "upload",
          documentCount: 1,
          issuesFound: 99,
          completedAt: new Date(completedAt.getTime() - 60 * 60 * 1000),
        },
      ]);

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        const stats = (await service.getStats(fx.organizationId)) as Record<
          string,
          unknown
        >;
        const last = stats.lastScan as Record<string, unknown>;

        check("lastScan.at is set", !!last.at, last.at);
        checkEqual(
          "both matters in the batch are counted",
          last.mattersReviewed,
          2,
        );
        checkEqual(
          "issuesFound sums across the batch, excluding older runs",
          last.issuesFound,
          7,
        );
        checkEqual(
          "nothing resolved since the scan",
          last.resolvedSince,
          0,
        );
      });
    } finally {
      await systemDb
        .delete(aiScanJobs)
        .where(eq(aiScanJobs.organizationId, fx.organizationId));
      await systemDb
        .delete(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
    }
  });

  // ── by-case ───────────────────────────────────────────────────────────────
  await withTempFixture({ docs: [], withCase: true }, async (fx) => {
    const c = fx.case!;
    try {
      // Issue on the lead only; the case stays Clear.
      await seedIssue(fx.organizationId, fx.leadId, { severity: "high" });
      await seedIssue(fx.organizationId, fx.leadId, { severity: "low" });

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("by-case — every active matter, including clear ones");

        const page = await service.getByCase(fx.organizationId, {});
        const rows = page.data as Record<string, unknown>[];

        const lead = rows.find((r) => r.id === fx.leadId);
        const kase = rows.find((r) => r.id === c.caseId);

        check("leads are listed, not just cases", !!lead, rows.map((r) => r.type));
        check("the case is listed", !!kase);

        checkEqual("lead counts criticals (critical+high)", lead?.critical, 1);
        checkEqual("lead counts warnings (medium+low)", lead?.warnings, 1);
        checkEqual("a matter with criticals is flagged critical", lead?.status, "critical");

        checkEqual("a matter with no issues counts zero", kase?.critical, 0);
        checkEqual(
          "a matter with no issues is Clear",
          kase?.status,
          "clear",
        );
        checkEqual(
          "the case carries its case number as reference",
          kase?.reference,
          c.caseNumber,
        );
        checkEqual("a lead has no case number", lead?.reference, null);
        check(
          "initials are derived for the avatar chip",
          typeof kase?.initials === "string" && (kase.initials as string).length > 0,
          kase?.initials,
        );

        check(
          "results are ordered by name",
          rows.every(
            (r, i) =>
              i === 0 ||
              String(rows[i - 1].name).localeCompare(String(r.name)) <= 0,
          ),
          rows.map((r) => r.name),
        );

        checkEqual("total counts every matter", page.pagination.total, 2);
      });
    } finally {
      await systemDb
        .delete(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
    }
  });

  // ── by-document ───────────────────────────────────────────────────────────
  await withTempFixture(
    { docs: [{ title: "Passport" }], withCase: true },
    async (fx) => {
      const doc = fx.docs[0];
      try {
        const issue = await seedIssue(fx.organizationId, fx.leadId, {
          issueType: "document_expiry_before_deadline",
          templateKey: "document_expiry_before_deadline",
          templateParams: { documentTitle: "Passport", deadline: "2026-06-22" },
        });
        await systemDb.insert(caseIssueDocuments).values({
          issueId: issue.id,
          documentId: doc.id,
          documentVersionId: doc.versionId,
        });

        // A required document that has not arrived — no `documents` row exists.
        await systemDb.insert(scenarioDocumentRequirements).values({
          organizationId: fx.organizationId,
          leadId: fx.leadId,
          label: "I-693 Medical exam",
          documentTypeSlug: "medical_exam",
          isRequired: true,
          source: "template",
        });

        await withOrgContext(fx.organizationId, fx.userId, async () => {
          section("by-document — flagged documents and awaited ones");

          const page = await service.getByDocument(fx.organizationId, {});
          const rows = page.data as Record<string, unknown>[];

          const flagged = rows.find((r) => r.documentId === doc.id);
          const missing = rows.find((r) => r.title === "I-693 Medical exam");

          check("the flagged document is listed", !!flagged);
          checkEqual("it links back to its issue", flagged?.issueId, issue.id);
          checkEqual(
            "its flag reuses the issue category",
            flagged?.flag,
            "DOCUMENT RISK",
          );
          checkEqual("source defaults to firm", flagged?.source, "firm");

          check(
            "a required-but-absent document is listed even with no document row",
            !!missing,
            rows.map((r) => r.title),
          );
          checkEqual("it has no document id", missing?.documentId, null);
          checkEqual(
            "its source is pending_client",
            missing?.source,
            "pending_client",
          );
          checkEqual("its flag is MISSING DOCUMENT", missing?.flag, "MISSING DOCUMENT");
          checkEqual("it has no date yet", missing?.date, null);

          const matter = missing?.matter as Record<string, unknown>;
          checkEqual("the awaited row names its matter", matter?.id, fx.leadId);

          checkEqual("both rows counted", page.pagination.total, 2);
        });
      } finally {
        await systemDb
          .delete(scenarioDocumentRequirements)
          .where(
            eq(scenarioDocumentRequirements.organizationId, fx.organizationId),
          );
        await systemDb
          .delete(caseIssues)
          .where(eq(caseIssues.organizationId, fx.organizationId));
      }
    },
  );

  // ── resolution log ────────────────────────────────────────────────────────
  await withTempFixture({ docs: [] }, async (fx) => {
    try {
      const detectedAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
      const resolvedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

      const resolved = await seedIssue(fx.organizationId, fx.leadId, {
        status: "resolved",
        detectedAt,
        resolvedAt,
        resolvedById: fx.staffId,
      });
      await systemDb.insert(caseIssueEvents).values({
        issueId: resolved.id,
        fromStatus: "open",
        toStatus: "resolved",
        actorStaffId: fx.staffId,
        actionKey: "request_reupload",
      });

      // Still open — must not appear in the log.
      await seedIssue(fx.organizationId, fx.leadId);

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("resolution log");

        const page = await service.getResolutionLog(fx.organizationId, {});
        const rows = page.data as Record<string, unknown>[];

        checkEqual("only resolved issues appear", rows.length, 1);
        const row = rows[0];
        checkEqual("it is the resolved one", row.id, resolved.id);

        const by = row.resolvedBy as Record<string, unknown> | null;
        checkEqual("resolver name is joined from staff", by?.name, fx.staffName);
        checkEqual("resolver role is carried", by?.role, "paralegal");

        checkEqual("action key carried", row.actionKey, "request_reupload");
        checkEqual(
          "action taken renders as past tense",
          row.actionTaken,
          "Re-upload requested",
        );

        const summary = page.summary as Record<string, unknown>;
        checkEqual("summary counts resolved issues", summary.resolved, 1);
        checkEqual("summary reports the window", summary.windowDays, 30);
        checkEqual(
          "average resolution time is in days",
          summary.averageResolutionDays,
          2,
        );
      });
    } finally {
      await systemDb
        .delete(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
    }
  });

  // ── contextual actions ──────────────────────────────────────────────────────
  await withTempFixture({ docs: [], withCase: true }, async (fx) => {
    const c = fx.case!;
    const sent: { to: string; subject: string }[] = [];
    const deps = {
      sendEmail: async (o: { to: string; subject: string; html: string }) => {
        sent.push({ to: o.to, subject: o.subject });
      },
    };

    try {
      section("actions — scenario-aware availability");

      // A lead issue offers email + attorney task; a case issue offers calendar.
      const leadIssue = await seedIssue(fx.organizationId, fx.leadId, {
        issueType: "document_expiry_before_deadline",
        templateKey: "document_expiry_before_deadline",
        templateParams: { documentTitle: "Passport", deadline: "2026-06-22" },
      });
      const caseIssue = await seedIssue(fx.organizationId, fx.leadId, {
        leadId: null,
        caseId: c.caseId,
        clientId: c.clientId,
        issueType: "deadline_approaching_incomplete",
        templateKey: "deadline_approaching_incomplete",
        templateParams: { deadline: "2026-06-22" },
      });

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        const leadDetail = (await service.getIssueById(
          fx.organizationId,
          leadIssue.id,
        )) as Record<string, unknown>;
        const leadActions = leadDetail.actions as {
          key: string;
          stub: boolean;
        }[];
        const leadFlag = leadActions.find((a) => a.key === "flag_for_attorney");
        check(
          "a lead expiry issue offers the attorney-task action",
          !!leadFlag,
          leadActions.map((a) => a.key),
        );
        checkEqual("it is implemented for leads (not a stub)", leadFlag?.stub, false);
        check(
          "it does not offer the case-only calendar action",
          !leadActions.some((a) => a.key === "set_calendar_alert"),
          leadActions.map((a) => a.key),
        );

        const caseDetail = (await service.getIssueById(
          fx.organizationId,
          caseIssue.id,
        )) as Record<string, unknown>;
        const caseActions = caseDetail.actions as {
          key: string;
          stub: boolean;
        }[];
        check(
          "a case deadline issue offers the calendar action",
          caseActions.some((a) => a.key === "set_calendar_alert"),
          caseActions.map((a) => a.key),
        );

        section("actions — stubs are offered but flagged");

        // flag_for_attorney is offered on cases per product, but not wired.
        const caseFlagIssue = await seedIssue(fx.organizationId, fx.leadId, {
          leadId: null,
          caseId: c.caseId,
          clientId: c.clientId,
          issueType: "photo_mismatch",
          templateKey: "photo_mismatch",
          templateParams: {},
        });
        const caseFlagDetail = (await service.getIssueById(
          fx.organizationId,
          caseFlagIssue.id,
        )) as Record<string, unknown>;
        const caseFlag = (
          caseFlagDetail.actions as { key: string; stub: boolean }[]
        ).find((a) => a.key === "flag_for_attorney");
        check("flag_for_attorney is offered on a case issue", !!caseFlag, caseFlagDetail.actions);
        checkEqual("but flagged as a stub on cases", caseFlag?.stub, true);

        // mark_as_filed is offered on a filing issue but always a stub.
        const filingIssue = await seedIssue(fx.organizationId, fx.leadId, {
          leadId: null,
          caseId: c.caseId,
          clientId: c.clientId,
          issueType: "filing_not_marked_submitted",
          templateKey: "filing_not_marked_submitted",
          templateParams: {},
        });
        const filingDetail = (await service.getIssueById(
          fx.organizationId,
          filingIssue.id,
        )) as Record<string, unknown>;
        const markFiled = (
          filingDetail.actions as { key: string; stub: boolean }[]
        ).find((a) => a.key === "mark_as_filed");
        check("mark_as_filed is offered on a filing issue", !!markFiled, filingDetail.actions);
        checkEqual("and flagged as a stub", markFiled?.stub, true);

        section("actions — dispatching a stub is refused");

        let stubRejected = false;
        try {
          await service.runAction(
            fx.organizationId,
            filingIssue.id,
            "mark_as_filed",
            fx.staffId,
            deps,
          );
        } catch (err) {
          stubRejected = true;
          check(
            "the refusal is a 501 Not Implemented",
            (err as { statusCode?: number }).statusCode === 501,
            (err as { statusCode?: number }).statusCode,
          );
        }
        check("a stub action is not executed", stubRejected);

        const stubEvents = await systemDb
          .select()
          .from(caseIssueEvents)
          .where(eq(caseIssueEvents.issueId, filingIssue.id));
        checkEqual(
          "no event is recorded for a refused stub",
          stubEvents.length,
          0,
        );

        section("actions — email dispatch (lead)");

        const emailRes = (await service.runAction(
          fx.organizationId,
          leadIssue.id,
          "request_reupload",
          fx.staffId,
          deps,
        )) as Record<string, unknown>;
        checkEqual("a mutation was reported", emailRes.kind, "mutation");
        checkEqual("one email was sent", sent.length, 1);
        check(
          "it went to the lead's address",
          sent[0]?.to.includes("lead-"),
          sent[0]?.to,
        );

        const [afterEmail] = await systemDb
          .select()
          .from(caseIssues)
          .where(eq(caseIssues.id, leadIssue.id));
        checkEqual(
          "the issue moved to under_review",
          afterEmail?.status,
          "under_review",
        );

        const emailEvents = await systemDb
          .select()
          .from(caseIssueEvents)
          .where(eq(caseIssueEvents.issueId, leadIssue.id));
        check(
          "an event recorded the action key",
          emailEvents.some((e) => e.actionKey === "request_reupload"),
          emailEvents.map((e) => e.actionKey),
        );

        section("actions — task dispatch (lead)");

        await service.runAction(
          fx.organizationId,
          leadIssue.id,
          "flag_for_attorney",
          fx.staffId,
          deps,
        );
        const tasks = await systemDb
          .select()
          .from(leadTasks)
          .where(eq(leadTasks.leadId, fx.leadId));
        check("a lead task was created", tasks.length >= 1, tasks.length);

        section("actions — calendar dispatch (case)");

        await service.runAction(
          fx.organizationId,
          caseIssue.id,
          "set_calendar_alert",
          fx.staffId,
          deps,
        );
        const events = await systemDb
          .select()
          .from(calendarEvents)
          .where(eq(calendarEvents.caseId, c.caseId));
        check("a calendar event was created", events.length >= 1, events.length);

        section("actions — navigate performs no effect");

        const nav = (await service.runAction(
          fx.organizationId,
          caseIssue.id,
          "view_case",
          fx.staffId,
          deps,
        )) as Record<string, unknown>;
        checkEqual("navigate is reported as such", nav.kind, "navigate");
        checkEqual("it targets the case", nav.target, "case");

        section("actions — an illegal action is rejected");

        let rejected = false;
        try {
          // Calendar alert is case-only; not valid on the lead issue.
          await service.runAction(
            fx.organizationId,
            leadIssue.id,
            "set_calendar_alert",
            fx.staffId,
            deps,
          );
        } catch {
          rejected = true;
        }
        check("an action the issue does not offer is rejected", rejected);
      });
    } finally {
      await systemDb
        .delete(calendarEvents)
        .where(eq(calendarEvents.organizationId, fx.organizationId));
      await systemDb
        .delete(leadTasks)
        .where(eq(leadTasks.organizationId, fx.organizationId));
      await systemDb
        .delete(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
    }
  });

  // ── report-export util ──────────────────────────────────────────────────────
  section("export util — CSV quoting (fast-csv)");

  {
    const columns = [
      { header: "Col A", value: (r: { a: unknown; b: unknown }) => r.a },
      { header: "Col B", value: (r: { a: unknown; b: unknown }) => r.b },
    ];
    const csv = await renderCsv(
      [
        { a: "plain", b: "has,comma" },
        { a: 'has"quote', b: "line1\nline2" },
        { a: null, b: 42 },
      ],
      columns,
    );
    const stripped = csv.replace(/^﻿/, "");
    check("starts with a UTF-8 BOM for Excel", csv.charCodeAt(0) === 0xfeff);
    check("header row present", stripped.startsWith("Col A,Col B"), stripped.slice(0, 20));
    check("a comma forces quoting", stripped.includes('"has,comma"'), stripped);
    check(
      "embedded quotes are doubled",
      stripped.includes('"has""quote"'),
      stripped,
    );
    check(
      "null renders empty and numbers stringify",
      stripped.includes(",42"),
      stripped,
    );
  }

  section("export util — PDF");

  {
    const pdf = await renderPdf(
      [{ a: "x" }, { a: "y" }],
      [{ header: "Col A", value: (r: { a: string }) => r.a }],
      { title: "Test", subtitle: "sub" },
    );
    check("PDF is a Buffer", Buffer.isBuffer(pdf));
    check("PDF has content", pdf.length > 0, pdf.length);
    check(
      "PDF starts with the %PDF magic bytes",
      pdf.subarray(0, 5).toString("latin1") === "%PDF-",
      pdf.subarray(0, 8).toString("latin1"),
    );
    check(
      "an empty report still renders a valid PDF",
      (await renderPdf([], [{ header: "X", value: () => "" }], { title: "T" }))
        .subarray(0, 5)
        .toString("latin1") === "%PDF-",
    );
  }

  // ── export endpoints ──────────────────────────────────────────────────────
  await withTempFixture({ docs: [], withCase: true }, async (fx) => {
    const c = fx.case!;
    try {
      await seedIssue(fx.organizationId, fx.leadId, {
        leadId: null,
        caseId: c.caseId,
        clientId: c.clientId,
        severity: "critical",
      });

      const resolvedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const resolved = await seedIssue(fx.organizationId, fx.leadId, {
        status: "resolved",
        detectedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        resolvedAt,
        resolvedById: fx.staffId,
      });
      await systemDb.insert(caseIssueEvents).values({
        issueId: resolved.id,
        fromStatus: "open",
        toStatus: "resolved",
        actorStaffId: fx.staffId,
        actionKey: "send_client_reminder",
      });

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("export — issues, CSV format");

        const issuesCsv = await service.exportIssues(fx.organizationId, {}, "csv");
        checkEqual("filename is .csv", issuesCsv.filename, "ai-review-issues.csv");
        checkEqual("mime is text/csv", issuesCsv.mime, "text/csv; charset=utf-8");
        const issueLines = (issuesCsv.body as string)
          .replace(/^﻿/, "")
          .trim()
          .split("\n")
          .map((l) => l.replace(/\r$/, ""));
        checkEqual(
          "header lists the issue columns",
          issueLines[0],
          "Severity,Category,Title,Status,Client,Matter,Matter type,Detected",
        );
        check(
          "the active issue is a data row",
          issueLines.length === 2,
          issueLines.length,
        );
        check(
          "the row carries the case number",
          issueLines[1].includes(c.caseNumber),
          issueLines[1],
        );

        section("export — issues, PDF format");

        const issuesPdf = await service.exportIssues(fx.organizationId, {}, "pdf");
        checkEqual("filename is .pdf", issuesPdf.filename, "ai-review-issues.pdf");
        checkEqual("mime is application/pdf", issuesPdf.mime, "application/pdf");
        check("body is a PDF buffer", Buffer.isBuffer(issuesPdf.body));
        check(
          "it is a valid PDF",
          (issuesPdf.body as Buffer).subarray(0, 5).toString("latin1") === "%PDF-",
        );

        section("export — resolution log, both formats");

        const logCsv = await service.exportResolutionLog(fx.organizationId, {}, "csv");
        checkEqual(
          "log filename is .csv",
          logCsv.filename,
          "ai-review-resolution-log.csv",
        );
        const logLines = (logCsv.body as string)
          .replace(/^﻿/, "")
          .trim()
          .split("\n")
          .map((l) => l.replace(/\r$/, ""));
        checkEqual(
          "header lists the log columns",
          logLines[0],
          "Issue,Client,Matter,Resolved by,Role,Resolved date,Action taken",
        );
        check(
          "only the resolved issue is exported",
          logLines.length === 2,
          logLines.length,
        );
        check(
          "the resolver name is present",
          logLines[1].includes(fx.staffName),
          logLines[1],
        );
        check(
          "the action taken renders past-tense",
          logLines[1].includes("Reminder sent"),
          logLines[1],
        );

        const logPdf = await service.exportResolutionLog(
          fx.organizationId,
          {},
          "pdf",
        );
        check(
          "log PDF is valid",
          (logPdf.body as Buffer).subarray(0, 5).toString("latin1") === "%PDF-",
        );
      });
    } finally {
      await systemDb
        .delete(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
    }
  });

  await report();
};

void main();
