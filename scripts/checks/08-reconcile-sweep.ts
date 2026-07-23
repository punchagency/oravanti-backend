/**
 * Tier 1 — Postgres. The two time-driven background paths.
 *
 *   npm run check 08-reconcile-sweep
 *
 * Reconciliation matters because a stuck job is not merely untidy: its
 * in-flight row blocks every future scan of that scenario through coalescing.
 * A lost result message would silence a scenario permanently without it.
 *
 * The sweep matters because deadline and missing-document issues are functions
 * of time, not of uploads. Without it they would only appear when someone
 * happened to upload a document.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, systemDb } from "../../src/db/client";
import { aiScanJobs } from "../../src/db/schema/ai-scan-jobs";
import { caseIssues } from "../../src/db/schema/case-issues";
import { scenarioDocumentRequirements } from "../../src/db/schema/document-requirements";
import {
  markScanRunning,
  reconcileStuckScans,
} from "../../src/modules/ai-scan/scan-result.service";
import { enqueueScenarioScan } from "../../src/modules/ai-scan/scan-producer";
import { sweepDeterministicIssues } from "../../src/modules/case-review/deterministic-sweep";
import { aiScanQueue } from "../../src/queue/queues";
import {
  check,
  checkEqual,
  report,
  section,
  withOrgContext,
  withTempFixture,
} from "./_bootstrap";

/** Backdate a job's timestamps so the reconciler treats it as stale. */
const backdate = async (jobId: string, column: "started_at" | "created_at", ms: number) => {
  await systemDb.execute(
    sql.raw(
      `UPDATE ai_scan_jobs SET ${column} = now() - interval '${ms} milliseconds' WHERE id = '${jobId}'`,
    ),
  );
};

const main = async () => {
  // ── markScanRunning + reconcileStuckScans ─────────────────────────────────
  await withTempFixture({ docs: [{ title: "Passport" }] }, async (fx) => {
    const jobIds: string[] = [];
    try {
      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("markScanRunning — queued → running");

        const enq = await enqueueScenarioScan({
          organizationId: fx.organizationId,
          scenarioType: "lead",
          scenarioId: fx.leadId,
          trigger: "manual",
          debounceMs: 0,
        });
        jobIds.push(enq.jobId);

        await markScanRunning(enq.jobId);

        const [running] = await db
          .select()
          .from(aiScanJobs)
          .where(eq(aiScanJobs.id, enq.jobId));
        checkEqual("status advanced to running", running?.status, "running");
        check("startedAt was stamped", !!running?.startedAt);

        section("markScanRunning is only valid from queued");

        // Simulate the result having landed first: a completed job must not be
        // dragged back to running by a late `active` event.
        await systemDb
          .update(aiScanJobs)
          .set({ status: "complete", completedAt: new Date() })
          .where(eq(aiScanJobs.id, enq.jobId));

        await markScanRunning(enq.jobId);
        const [stillComplete] = await db
          .select()
          .from(aiScanJobs)
          .where(eq(aiScanJobs.id, enq.jobId));
        checkEqual(
          "a completed job is not reverted to running",
          stillComplete?.status,
          "complete",
        );
      });

      section("reconcileStuckScans — a running job that never reported back");

      // Fresh stuck job, backdated past the 30-minute running timeout.
      const [stuckRunning] = await systemDb
        .insert(aiScanJobs)
        .values({
          organizationId: fx.organizationId,
          leadId: fx.leadId,
          status: "running",
          trigger: "manual",
          documentCount: 1,
          cachedCount: 0,
          startedAt: new Date(),
        })
        .returning();
      jobIds.push(stuckRunning.id);
      await backdate(stuckRunning.id, "started_at", 31 * 60 * 1000);

      const first = await reconcileStuckScans();
      check("at least one stale running job was swept", first.staleRunning >= 1, first);

      const [sweptRunning] = await systemDb
        .select()
        .from(aiScanJobs)
        .where(eq(aiScanJobs.id, stuckRunning.id));
      checkEqual("it was failed", sweptRunning?.status, "failed");
      check(
        "the error explains why",
        (sweptRunning?.error ?? "").includes("timed out"),
        sweptRunning?.error,
      );
      check("completedAt was stamped", !!sweptRunning?.completedAt);

      section("reconcileStuckScans — a queued job that never started");

      const [stuckQueued] = await systemDb
        .insert(aiScanJobs)
        .values({
          organizationId: fx.organizationId,
          leadId: fx.leadId,
          status: "queued",
          trigger: "manual",
          documentCount: 1,
          cachedCount: 0,
        })
        .returning();
      jobIds.push(stuckQueued.id);
      await backdate(stuckQueued.id, "created_at", 61 * 60 * 1000);

      const second = await reconcileStuckScans();
      check("at least one stale queued job was swept", second.staleQueued >= 1, second);

      const [sweptQueued] = await systemDb
        .select()
        .from(aiScanJobs)
        .where(eq(aiScanJobs.id, stuckQueued.id));
      checkEqual("it was failed", sweptQueued?.status, "failed");
      check(
        "the error explains why",
        (sweptQueued?.error ?? "").includes("never started"),
        sweptQueued?.error,
      );

      section("fresh jobs are left alone");

      const [fresh] = await systemDb
        .insert(aiScanJobs)
        .values({
          organizationId: fx.organizationId,
          leadId: fx.leadId,
          status: "running",
          trigger: "manual",
          documentCount: 1,
          cachedCount: 0,
          startedAt: new Date(),
        })
        .returning();
      jobIds.push(fresh.id);

      await reconcileStuckScans();
      const [untouched] = await systemDb
        .select()
        .from(aiScanJobs)
        .where(eq(aiScanJobs.id, fresh.id));
      checkEqual("a recent running job is still running", untouched?.status, "running");

      section("clearing a stuck job unblocks future scans");

      // The point of reconciliation: coalescing keys off in-flight rows, so a
      // stuck job would otherwise silence the scenario forever.
      await systemDb
        .update(aiScanJobs)
        .set({ status: "failed" })
        .where(eq(aiScanJobs.id, fresh.id));

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        const retry = await enqueueScenarioScan({
          organizationId: fx.organizationId,
          scenarioType: "lead",
          scenarioId: fx.leadId,
          trigger: "manual",
          debounceMs: 0,
        });
        if (retry.jobId) jobIds.push(retry.jobId);
        check("a new scan can be enqueued once nothing is in flight", !retry.coalesced);
      });
    } finally {
      for (const id of jobIds) {
        await aiScanQueue
          .getJob(id)
          .then((j) => j?.remove())
          .catch(() => {});
      }
      await systemDb
        .delete(aiScanJobs)
        .where(eq(aiScanJobs.organizationId, fx.organizationId));
    }
  });

  // ── sweepDeterministicIssues ──────────────────────────────────────────────
  await withTempFixture({ docs: [] }, async (fx) => {
    try {
      section("sweep — an unmet requirement raises an issue without any scan");

      await systemDb.insert(scenarioDocumentRequirements).values({
        organizationId: fx.organizationId,
        leadId: fx.leadId,
        label: "Passport",
        documentTypeSlug: "passport",
        isRequired: true,
        source: "template",
      });

      const before = await systemDb
        .select()
        .from(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
      checkEqual("no issues before the sweep", before.length, 0);

      const result = await sweepDeterministicIssues();
      check("the sweep visited at least one scenario", result.scenarios >= 1, result);
      checkEqual("the sweep reported no errors", result.errors, 0);

      const after = await systemDb
        .select()
        .from(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));

      check("an issue was raised", after.length >= 1, after.length);
      const missing = after.find(
        (i) => i.issueType === "missing_required_document",
      );
      check("it is a missing_required_document issue", !!missing, after.map((i) => i.issueType));
      checkEqual("raised by a rule, not the AI", missing?.source, "rule");
      checkEqual("it is open", missing?.status, "open");
      checkEqual("scoped to the org", missing?.organizationId, fx.organizationId);
      checkEqual("attached to the lead", missing?.leadId, fx.leadId);

      section("the sweep is idempotent");

      const rerun = await sweepDeterministicIssues();
      checkEqual("still no errors", rerun.errors, 0);

      const afterRerun = await systemDb
        .select()
        .from(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
      checkEqual("no duplicate issue was created", afterRerun.length, after.length);
      checkEqual(
        "the issue id is stable",
        afterRerun.find((i) => i.issueType === "missing_required_document")?.id,
        missing?.id,
      );

      section("satisfying the requirement supersedes the issue");

      await systemDb
        .update(scenarioDocumentRequirements)
        .set({ waivedAt: new Date(), waiveReason: "check" })
        .where(
          and(
            eq(scenarioDocumentRequirements.organizationId, fx.organizationId),
            eq(scenarioDocumentRequirements.leadId, fx.leadId),
          ),
        );

      await sweepDeterministicIssues();

      const [resolved] = await systemDb
        .select()
        .from(caseIssues)
        .where(eq(caseIssues.id, missing!.id));
      checkEqual(
        "the issue is superseded once the requirement is waived",
        resolved?.status,
        "superseded",
      );
    } finally {
      await systemDb
        .delete(caseIssues)
        .where(eq(caseIssues.organizationId, fx.organizationId));
      await systemDb
        .delete(scenarioDocumentRequirements)
        .where(eq(scenarioDocumentRequirements.organizationId, fx.organizationId));
    }
  });

  await aiScanQueue.close().catch(() => {});
  await report();
};

void main();
