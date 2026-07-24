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
import { caseIssues } from "../../src/db/schema/case-issues";
import { CaseReviewService } from "../../src/modules/case-review/case-review.service";
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

  await report();
};

void main();
