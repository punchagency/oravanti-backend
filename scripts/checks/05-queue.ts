/**
 * Tier 2 — Postgres + Redis. The backend's half of the queue seam.
 *
 *   npm run check 05-queue
 *
 * Covers the producer (job row, coalescing via the in-flight partial unique
 * index, the payload actually placed on the queue) and the result consumer
 * (cache write, issue sync, terminal status, idempotency).
 *
 * The Python worker is not involved: this drives `persistScanResult` directly
 * with a synthetic result. For the genuine cross-language round trip — backend
 * enqueues, Python consumes, backend persists — see `roundtrip.sh`.
 */
import { and, eq } from "drizzle-orm";
import { db, systemDb } from "../../src/db/client";
import { aiScanJobs } from "../../src/db/schema/ai-scan-jobs";
import { aiSystemConfig } from "../../src/db/schema/ai-system-config";
import { caseIssues } from "../../src/db/schema/case-issues";
import { documentAnalyses } from "../../src/db/schema/document-analyses";
import type { AiScanResultJob } from "../../src/modules/ai-scan/contract";
import { enqueueScenarioScan } from "../../src/modules/ai-scan/scan-producer";
import { persistScanResult } from "../../src/modules/ai-scan/scan-result.service";
import {
  AI_MODEL_VERSION,
  effectivePromptVersion,
} from "../../src/modules/ai-scan/vocabulary";
import { aiScanQueue } from "../../src/queue/queues";
import {
  check,
  checkEqual,
  report,
  section,
  withOrgContext,
  withTempFixture,
} from "./_bootstrap";

const resultFor = (
  jobId: string,
  docId: string,
  checksum: string,
  overrides: Partial<AiScanResultJob> = {},
): AiScanResultJob => ({
  schema_version: 1,
  job_id: jobId,
  status: "complete",
  model_version: AI_MODEL_VERSION,
  prompt_version: effectivePromptVersion(),
  documents: [
    {
      id: docId,
      checksum,
      document_type: "passport",
      extracted_fields: { full_name: "Queue Check", date_of_birth: "1990-04-17" },
      has_photo: false,
      authenticity: { verdict: "genuine", confidence: 0.93 },
      ocr_artifact_key: `ai-artifacts/${checksum}.txt`,
    },
  ],
  conflicts: [],
  photo_comparisons: [],
  errors: [],
  ...overrides,
});

const main = async () => {
  await withTempFixture(
    { docs: [{ title: "Passport" }] }, // no analysis → a real scan is warranted
    async (fx) => {
      const doc = fx.docs[0];
      const enqueuedJobIds: string[] = [];

      try {
        await withOrgContext(fx.organizationId, fx.userId, async () => {
          section("producer — first enqueue");

          const first = await enqueueScenarioScan({
            organizationId: fx.organizationId,
            scenarioType: "lead",
            scenarioId: fx.leadId,
            trigger: "manual",
            debounceMs: 0,
          });
          enqueuedJobIds.push(first.jobId);

          check("a job was enqueued", first.enqueued);
          check("it was not coalesced", !first.coalesced);

          const [row] = await db
            .select()
            .from(aiScanJobs)
            .where(eq(aiScanJobs.id, first.jobId));
          check("an ai_scan_jobs row was written", !!row);
          checkEqual("status is queued", row?.status, "queued");
          checkEqual("scoped to the org", row?.organizationId, fx.organizationId);
          checkEqual("linked to the lead", row?.leadId, fx.leadId);
          checkEqual("caseId is null for a lead scenario", row?.caseId, null);
          checkEqual("trigger recorded", row?.trigger, "manual");
          checkEqual("documentCount recorded", row?.documentCount, 1);
          checkEqual("cachedCount is 0 (no prior analysis)", row?.cachedCount, 0);
          check("queueJobId was written back", !!row?.queueJobId, row?.queueJobId);

          const meta = row?.runMetadata as Record<string, string> | undefined;
          checkEqual("runMetadata pins the model", meta?.modelVersion, AI_MODEL_VERSION);
          checkEqual(
            "runMetadata pins the prompt",
            meta?.promptVersion,
            effectivePromptVersion(),
          );

          section("the payload actually reached BullMQ");

          const queued = await aiScanQueue.getJob(first.jobId);
          check("the job exists on the ai-scan queue", !!queued);
          checkEqual("BullMQ job id matches the row id", queued?.id, first.jobId);

          const payload = queued?.data;
          checkEqual("payload job_id matches", payload?.job_id, first.jobId);
          checkEqual(
            "payload organization_id matches",
            payload?.organization_id,
            fx.organizationId,
          );
          checkEqual("payload carries the document", payload?.documents?.length, 1);
          checkEqual(
            "payload document id matches the fixture",
            payload?.documents?.[0]?.id,
            doc.id,
          );
          checkEqual(
            "payload prompt_version matches the row",
            payload?.prompt_version,
            effectivePromptVersion(),
          );

          section("coalescing — a second enqueue joins the in-flight job");

          const second = await enqueueScenarioScan({
            organizationId: fx.organizationId,
            scenarioType: "lead",
            scenarioId: fx.leadId,
            trigger: "upload",
            debounceMs: 0,
          });

          check("the second call coalesced", second.coalesced);
          check("nothing new was enqueued", !second.enqueued);
          checkEqual("it returned the in-flight job id", second.jobId, first.jobId);

          const rows = await db
            .select()
            .from(aiScanJobs)
            .where(
              and(
                eq(aiScanJobs.organizationId, fx.organizationId),
                eq(aiScanJobs.leadId, fx.leadId),
              ),
            );
          checkEqual("still exactly one job row", rows.length, 1);

          section("consumer — persisting a result");

          await persistScanResult(resultFor(first.jobId, doc.id, doc.checksum));

          const [after] = await db
            .select()
            .from(aiScanJobs)
            .where(eq(aiScanJobs.id, first.jobId));
          checkEqual("job reached a terminal status", after?.status, "complete");
          check("completedAt was stamped", !!after?.completedAt);

          const analyses = await db
            .select()
            .from(documentAnalyses)
            .where(eq(documentAnalyses.checksum, doc.checksum));
          checkEqual("an analysis row was cached", analyses.length, 1);
          checkEqual("cached as complete", analyses[0]?.status, "complete");
          checkEqual(
            "keyed by the prompt version",
            analyses[0]?.promptVersion,
            effectivePromptVersion(),
          );
          checkEqual("keyed by the model version", analyses[0]?.modelVersion, AI_MODEL_VERSION);
          checkEqual("document type stored", analyses[0]?.documentTypeSlug, "passport");
          check(
            "the cache row has no organization column",
            !("organizationId" in (analyses[0] ?? {})),
            Object.keys(analyses[0] ?? {}),
          );

          section("idempotency — the same result twice");

          await persistScanResult(resultFor(first.jobId, doc.id, doc.checksum));

          const analysesAgain = await db
            .select()
            .from(documentAnalyses)
            .where(eq(documentAnalyses.checksum, doc.checksum));
          checkEqual("no duplicate analysis rows", analysesAgain.length, 1);

          const issues = await db
            .select()
            .from(caseIssues)
            .where(eq(caseIssues.organizationId, fx.organizationId));
          check(
            "no duplicate issues were created",
            issues.length === new Set(issues.map((i) => i.issueKey)).size,
            issues.map((i) => i.issueKey),
          );

          section("a result for an unknown job is dropped, not thrown");

          let threw = false;
          try {
            await persistScanResult(
              resultFor(
                "00000000-0000-4000-8000-000000000000",
                doc.id,
                doc.checksum,
              ),
            );
          } catch {
            threw = true;
          }
          check("persisting an orphan result does not throw", !threw);

          section("after completion a new scan may be enqueued");

          const third = await enqueueScenarioScan({
            organizationId: fx.organizationId,
            scenarioType: "lead",
            scenarioId: fx.leadId,
            trigger: "manual",
            debounceMs: 0,
          });
          if (third.jobId) enqueuedJobIds.push(third.jobId);

          check("a terminal job no longer blocks new scans", !third.coalesced);
        });
      } finally {
        // BullMQ jobs outlive the DB fixture; remove them explicitly.
        for (const id of enqueuedJobIds) {
          await aiScanQueue
            .getJob(id)
            .then((j) => j?.remove())
            .catch(() => {});
        }
        await db.delete(aiScanJobs).where(eq(aiScanJobs.organizationId, fx.organizationId));
        await db
          .delete(documentAnalyses)
          .where(eq(documentAnalyses.checksum, doc.checksum));
        await aiScanQueue.close().catch(() => {});
      }
    },
  );

  // ── real-time gate ──────────────────────────────────────────────────────────
  await withTempFixture({ docs: [{ title: "Passport" }] }, async (fx) => {
    try {
      await systemDb.insert(aiSystemConfig).values({
        organizationId: fx.organizationId,
        realtimeAnalysis: false,
      });

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("real-time gate — upload scan skipped when realtime is off");

        const upload = await enqueueScenarioScan({
          organizationId: fx.organizationId,
          scenarioType: "lead",
          scenarioId: fx.leadId,
          trigger: "upload",
          debounceMs: 0,
        });
        checkEqual("an upload trigger does not enqueue", upload.enqueued, false);
        checkEqual("and is not coalesced", upload.coalesced, false);

        const rows = await db
          .select()
          .from(aiScanJobs)
          .where(eq(aiScanJobs.organizationId, fx.organizationId));
        checkEqual("no job row was written", rows.length, 0);

        section("real-time gate — a manual re-run still runs");

        const manual = await enqueueScenarioScan({
          organizationId: fx.organizationId,
          scenarioType: "lead",
          scenarioId: fx.leadId,
          trigger: "manual",
          debounceMs: 0,
        });
        check("a manual scan bypasses the gate", manual.enqueued, manual);
        check("it has a job id", !!manual.jobId, manual.jobId);
        await aiScanQueue
          .getJob(manual.jobId)
          .then((j) => j?.remove())
          .catch(() => {});
      });
    } finally {
      await db.delete(aiScanJobs).where(eq(aiScanJobs.organizationId, fx.organizationId));
      await systemDb
        .delete(aiSystemConfig)
        .where(eq(aiSystemConfig.organizationId, fx.organizationId));
      await aiScanQueue.close().catch(() => {});
    }
  });

  await report();
};

void main();
