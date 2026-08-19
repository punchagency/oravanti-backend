/**
 * Tier 1 — Postgres. Exercises the diff engine's full state machine against the
 * real schema: NEW → UNCHANGED → CHANGED → SUPERSEDED → REOPEN, plus the
 * `includeScanRules` guard that keeps a scan-less sweep from superseding
 * AI-derived issues.
 */
import { and, eq } from "drizzle-orm";
import { db, systemDb } from "../../src/db/client";
import { caseIssueDocuments, caseIssues } from "../../src/db/schema/case-issues";
import type { AiScanResultJob } from "../../src/modules/ai-scan/contract";
import { syncScenarioIssues } from "../../src/modules/case-review/issue-sync";
import {
  check,
  checkEqual,
  issueAuditEvents,
  report,
  section,
  toStatusOf,
  withOrgContext,
  withTempFixture,
} from "./_bootstrap";

/** A scan result carrying an optional single cross-document conflict. */
const resultWith = (
  conflict: { values: Record<string, string>; participants: string[] } | null,
): AiScanResultJob => ({
  schema_version: 1,
  job_id: "check-job",
  status: "complete",
  model_version: "gemini-2.5-flash",
  prompt_version: "v1",
  documents: [],
  conflicts: conflict
    ? [
        {
          field: "date_of_birth",
          participants: conflict.participants,
          values: conflict.values,
          verdict: "conflict",
          explanation: "Dates of birth disagree across documents",
        },
      ]
    : [],
  photo_comparisons: [],
  errors: [],
});

const main = async () => {
  await withTempFixture(
    {
      docs: [
        {
          title: "Passport",
          analysis: {
            documentTypeSlug: "passport",
            extractedFields: { date_of_birth: "1990-04-17" },
          },
        },
        {
          title: "Birth Certificate",
          analysis: {
            documentTypeSlug: "birth_certificate",
            extractedFields: { date_of_birth: "1991-04-17" },
          },
        },
      ],
    },
    async (fx) => {
      const params = {
        type: "lead" as const,
        id: fx.leadId,
        organizationId: fx.organizationId,
      };
      const participants = fx.docs.map((d) => d.id);

      const conflictA = {
        participants,
        values: {
          [participants[0]]: "1990-04-17",
          [participants[1]]: "1991-04-17",
        },
      };
      const conflictB = {
        participants,
        values: {
          [participants[0]]: "1990-04-17",
          [participants[1]]: "1992-12-01", // same key, different content
        },
      };

      const issuesForOrg = () =>
        db
          .select()
          .from(caseIssues)
          .where(eq(caseIssues.organizationId, fx.organizationId));

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        // ── NEW ────────────────────────────────────────────────────────────
        section("NEW — first detection");
        const s1 = await syncScenarioIssues(params, resultWith(conflictA));
        checkEqual("created = 1", s1.created, 1);
        checkEqual("active = 1", s1.active, 1);

        const after1 = await issuesForOrg();
        checkEqual("one issue row persisted", after1.length, 1);
        const issue = after1[0];
        checkEqual("status is open", issue.status, "open");
        checkEqual("source is ai", issue.source, "ai");
        checkEqual("affectedField carried", issue.affectedField, "date_of_birth");
        check(
          "severity is critical for an identity field",
          issue.severity === "critical",
          issue.severity,
        );
        checkEqual("scoped to the fixture org", issue.organizationId, fx.organizationId);
        checkEqual("linked to the lead", issue.leadId, fx.leadId);

        const links = await db
          .select()
          .from(caseIssueDocuments)
          .where(eq(caseIssueDocuments.issueId, issue.id));
        checkEqual("case_issue_documents populated on NEW", links.length, 2);

        const events1 = await issueAuditEvents(issue.id);
        checkEqual("one event recorded", events1.length, 1);
        checkEqual(
          "event opens the issue",
          events1[0].action,
          "case_review.issue_detected",
        );

        // ── UNCHANGED ──────────────────────────────────────────────────────
        section("UNCHANGED — same facts on rerun");
        const s2 = await syncScenarioIssues(params, resultWith(conflictA));
        checkEqual("unchanged = 1", s2.unchanged, 1);
        checkEqual("created = 0", s2.created, 0);
        checkEqual("superseded = 0", s2.superseded, 0);

        const after2 = await issuesForOrg();
        checkEqual("still exactly one row", after2.length, 1);
        checkEqual("id is stable (same issueKey)", after2[0].id, issue.id);
        checkEqual("contentHash unchanged", after2[0].contentHash, issue.contentHash);

        const events2 = await issueAuditEvents(issue.id);
        checkEqual("no extra event for an unchanged issue", events2.length, 1);

        // ── CHANGED ────────────────────────────────────────────────────────
        section("CHANGED — same key, new content");
        const s3 = await syncScenarioIssues(params, resultWith(conflictB));
        checkEqual("updated = 1", s3.updated, 1);
        checkEqual("created = 0", s3.created, 0);

        const after3 = await issuesForOrg();
        checkEqual("still one row", after3.length, 1);
        checkEqual("same row id", after3[0].id, issue.id);
        check(
          "contentHash advanced",
          after3[0].contentHash !== issue.contentHash,
          { before: issue.contentHash, after: after3[0].contentHash },
        );

        // ── includeScanRules guard ─────────────────────────────────────────
        section("SWEEP — must not supersede AI issues");
        const s4 = await syncScenarioIssues(params, resultWith(null), {
          includeScanRules: false,
        });
        checkEqual("sweep supersedes nothing", s4.superseded, 0);

        const after4 = await issuesForOrg();
        checkEqual("AI issue survives the sweep", after4.length, 1);
        checkEqual("still open after sweep", after4[0].status, "open");

        // ── SUPERSEDED ─────────────────────────────────────────────────────
        section("SUPERSEDED — conflict no longer reported");
        const s5 = await syncScenarioIssues(params, resultWith(null));
        checkEqual("superseded = 1", s5.superseded, 1);
        checkEqual("active = 0", s5.active, 0);

        const after5 = await issuesForOrg();
        checkEqual("row retained for audit", after5.length, 1);
        checkEqual("status is superseded", after5[0].status, "superseded");
        check("supersededAt stamped", after5[0].supersededAt !== null);

        // ── REOPEN ─────────────────────────────────────────────────────────
        section("REOPEN — issue detected again after a terminal state");
        const s6 = await syncScenarioIssues(params, resultWith(conflictA));
        checkEqual("reopened = 1", s6.reopened, 1);
        checkEqual("created = 0 (key was reused)", s6.created, 0);

        const after6 = await issuesForOrg();
        checkEqual("still one row", after6.length, 1);
        checkEqual("same row id across the whole lifecycle", after6[0].id, issue.id);
        check(
          "status is active again",
          ["open", "under_review"].includes(after6[0].status),
          after6[0].status,
        );

        const events6 = await issueAuditEvents(issue.id);
        check(
          "event trail records every transition",
          events6.length >= 3,
          events6.map((e) => `${e.action}${toStatusOf(e) ? ` -> ${toStatusOf(e)}` : ""}`),
        );
      });

      // ── Tenant isolation ────────────────────────────────────────────────
      // Deliberately NOT asserted here. This runs on the application
      // connection, and `oravanti_admin` is a superuser with BYPASSRLS that
      // also owns the tables, so RLS never engages for it no matter how
      // correct the policies are. Asserting isolation here would measure the
      // role exemption, not the policy. `07-rls` proves isolation properly by
      // connecting as a role RLS applies to.
      section("scoping (application-level)");

      const scoped = await withOrgContext(fx.organizationId, fx.userId, async () =>
        db
          .select()
          .from(caseIssues)
          .where(eq(caseIssues.organizationId, fx.organizationId)),
      );
      checkEqual("the org's issues are retrievable by org filter", scoped.length, 1);

      const systemRows = await systemDb
        .select()
        .from(caseIssues)
        .where(
          and(
            eq(caseIssues.organizationId, fx.organizationId),
            eq(caseIssues.leadId, fx.leadId),
          ),
        );
      checkEqual("the row exists", systemRows.length, 1);
    },
  );

  await report();
};

void main();
