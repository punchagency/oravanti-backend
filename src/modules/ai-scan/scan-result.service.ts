import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../../db/client";
import { aiScanJobs } from "../../db/schema/ai-scan-jobs";
import {
  documentAnalyses,
  documentPhotoComparisons,
} from "../../db/schema/document-analyses";
import {
  documentCaseLinks,
  documents,
  documentVersions,
} from "../../db/schema/documents";
import { leadDocumentLinks } from "../../db/schema/lead-document-links";
import type { AiScanResultJob } from "./contract";
import { enqueueScenarioScan } from "./scan-producer";
import type { ScenarioType } from "./scan-payload";

const scenarioOf = (job: {
  leadId: string | null;
  caseId: string | null;
}): { type: ScenarioType; id: string } | null => {
  if (job.leadId) return { type: "lead", id: job.leadId };
  if (job.caseId) return { type: "case", id: job.caseId };
  return null;
};

/** True if any of the scenario's current document versions still await analysis. */
const hasPendingDocuments = async (
  scenario: { type: ScenarioType; id: string },
): Promise<boolean> => {
  const isLead = scenario.type === "lead";
  const linkTable = isLead ? leadDocumentLinks : documentCaseLinks;
  const linkDocumentId = isLead
    ? leadDocumentLinks.documentId
    : documentCaseLinks.documentId;
  const linkScenarioCol = isLead
    ? leadDocumentLinks.leadId
    : documentCaseLinks.caseId;

  const [row] = await db
    .select({ id: documentVersions.id })
    .from(linkTable)
    .innerJoin(documents, eq(documents.id, linkDocumentId))
    .innerJoin(
      documentVersions,
      eq(documentVersions.id, documents.currentVersionId),
    )
    .where(
      and(
        eq(linkScenarioCol, scenario.id),
        eq(documentVersions.aiScanStatus, "pending"),
        eq(documents.status, "active"),
      ),
    )
    .limit(1);
  return !!row;
};

/**
 * Persist a scan result and close out its job.
 *
 * Idempotent by job_id: if the job is already terminal (a redelivered result),
 * this is a no-op. Cached-facts documents appear in the result too and upsert
 * harmlessly. Analyses and photo comparisons are content-addressed, so upserts
 * are safe to repeat.
 *
 * Note: this persists FACTS only. Turning facts into issues (and setting
 * issuesFound) is the rules engine's job in Phase 4 — hooked in where marked.
 */
export const persistScanResult = async (
  result: AiScanResultJob,
): Promise<void> => {
  const [job] = await db
    .select({
      id: aiScanJobs.id,
      status: aiScanJobs.status,
      organizationId: aiScanJobs.organizationId,
      leadId: aiScanJobs.leadId,
      caseId: aiScanJobs.caseId,
    })
    .from(aiScanJobs)
    .where(eq(aiScanJobs.id, result.job_id))
    .limit(1);

  if (!job) {
    console.warn(`[ai-scan] result for unknown job ${result.job_id} — dropping`);
    return;
  }
  if (
    job.status === "complete" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    return; // already processed — redelivery
  }

  const idToChecksum = new Map(result.documents.map((d) => [d.id, d.checksum]));

  await db.transaction(async (tx) => {
    // 1. Facts — one row per analysed document (content-addressed cache).
    for (const doc of result.documents) {
      await tx
        .insert(documentAnalyses)
        .values({
          checksum: doc.checksum,
          promptVersion: result.prompt_version,
          modelVersion: result.model_version,
          status: "complete",
          documentTypeSlug: doc.document_type,
          extractedFields: doc.extracted_fields,
          hasPhoto: doc.has_photo,
          authenticityVerdict: doc.authenticity.verdict,
          authenticityConfidence: String(doc.authenticity.confidence),
          ocrArtifactKey: doc.ocr_artifact_key,
        })
        .onConflictDoUpdate({
          target: [
            documentAnalyses.checksum,
            documentAnalyses.promptVersion,
            documentAnalyses.modelVersion,
          ],
          set: {
            status: "complete",
            documentTypeSlug: doc.document_type,
            extractedFields: doc.extracted_fields,
            hasPhoto: doc.has_photo,
            authenticityVerdict: doc.authenticity.verdict,
            authenticityConfidence: String(doc.authenticity.confidence),
            ocrArtifactKey: doc.ocr_artifact_key,
            error: null,
            analyzedAt: new Date(),
          },
        });

      // Mirror onto the scanned version(s) of this document.
      await tx
        .update(documentVersions)
        .set({ aiScanStatus: "complete", aiScannedAt: new Date() })
        .where(
          and(
            eq(documentVersions.documentId, doc.id),
            eq(documentVersions.checksum, doc.checksum),
          ),
        );
    }

    // 2. Pairwise photo comparisons (checksums stored sorted).
    for (const cmp of result.photo_comparisons) {
      const ca = idToChecksum.get(cmp.document_a);
      const cb = idToChecksum.get(cmp.document_b);
      if (!ca || !cb || ca === cb) continue;
      const [checksumA, checksumB] = ca < cb ? [ca, cb] : [cb, ca];
      await tx
        .insert(documentPhotoComparisons)
        .values({
          checksumA,
          checksumB,
          modelVersion: result.model_version,
          verdict: cmp.verdict,
          confidence: String(cmp.confidence),
        })
        .onConflictDoUpdate({
          target: [
            documentPhotoComparisons.checksumA,
            documentPhotoComparisons.checksumB,
            documentPhotoComparisons.modelVersion,
          ],
          set: {
            verdict: cmp.verdict,
            confidence: String(cmp.confidence),
            comparedAt: new Date(),
          },
        });
    }

    // 3. Per-document failures → mark those versions failed (not pending, so
    //    they don't drive an endless re-scan).
    const failedDocIds = [
      ...new Set(
        result.errors
          .filter((e) => e.document_id)
          .map((e) => e.document_id as string),
      ),
    ];
    if (failedDocIds.length > 0) {
      await tx
        .update(documentVersions)
        .set({ aiScanStatus: "failed", aiScannedAt: new Date() })
        .where(
          and(
            inArray(documentVersions.documentId, failedDocIds),
            inArray(documentVersions.aiScanStatus, [
              "pending",
              "queued",
              "running",
            ]),
          ),
        );
    }

    // 4. Close the job. issuesFound stays 0 until the rules engine runs.
    const scenarioErrors = result.errors
      .filter((e) => !e.document_id)
      .map((e) => `${e.stage}: ${e.message}`)
      .join("; ");
    await tx
      .update(aiScanJobs)
      .set({
        status: result.status === "failed" ? "failed" : "complete",
        completedAt: new Date(),
        error: scenarioErrors || null,
        updatedAt: new Date(),
      })
      .where(eq(aiScanJobs.id, job.id));
  });

  // TODO(Phase 4): hand `result` to the rules engine here to derive issues and
  // set ai_scan_jobs.issuesFound.

  // Coalescing re-check: documents uploaded while this scan was running (or a
  // brand-new version) sit at 'pending' — kick off another scan to cover them.
  const scenario = scenarioOf(job);
  if (scenario && (await hasPendingDocuments(scenario))) {
    await enqueueScenarioScan({
      organizationId: job.organizationId,
      scenarioType: scenario.type,
      scenarioId: scenario.id,
      trigger: "upload",
    }).catch((err) =>
      console.error("[ai-scan] re-scan enqueue failed:", err),
    );
  }
};

/** Mark a job running when the worker starts it (via the queue 'active' event). */
export const markScanRunning = async (jobId: string): Promise<void> => {
  await db
    .update(aiScanJobs)
    .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(aiScanJobs.id, jobId), eq(aiScanJobs.status, "queued")));
};

const RUNNING_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const QUEUED_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export type ReconcileResult = { staleRunning: number; staleQueued: number };

/**
 * Fail jobs that never reported back — a worker crash or a lost result message
 * would otherwise leave a job stuck forever, and its in-flight row would block
 * every future scan of that scenario (coalescing).
 */
export const reconcileStuckScans = async (): Promise<ReconcileResult> => {
  const now = Date.now();

  const running = await db
    .update(aiScanJobs)
    .set({
      status: "failed",
      error: "timed out (no result received)",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiScanJobs.status, "running"),
        lt(aiScanJobs.startedAt, new Date(now - RUNNING_TIMEOUT_MS)),
      ),
    )
    .returning({ id: aiScanJobs.id });

  const queued = await db
    .update(aiScanJobs)
    .set({
      status: "failed",
      error: "never started",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiScanJobs.status, "queued"),
        lt(aiScanJobs.createdAt, new Date(now - QUEUED_TIMEOUT_MS)),
      ),
    )
    .returning({ id: aiScanJobs.id });

  return { staleRunning: running.length, staleQueued: queued.length };
};
