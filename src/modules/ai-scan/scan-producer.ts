import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { aiScanJobs } from "../../db/schema/ai-scan-jobs";
import { cases } from "../../db/schema/cases";
import { documentCaseLinks, documents } from "../../db/schema/documents";
import { leadDocumentLinks } from "../../db/schema/lead-document-links";
import { leads } from "../../db/schema/leads";
import { enqueueAiScanJob } from "../../queue/queues";
import { AI_MODEL_VERSION, effectivePromptVersion } from "./vocabulary";
import { buildScanRequest, type ScenarioType } from "./scan-payload";

/** Time a scenario's scan waits before running, so a burst of uploads coalesces. */
const DEFAULT_DEBOUNCE_MS = 3000;

export type EnqueueScenarioScanParams = {
  organizationId: string;
  scenarioType: ScenarioType;
  scenarioId: string;
  trigger: "upload" | "manual" | "full_scan";
  requestedByStaffId?: string;
  /** Override the debounce window (0 for immediate — e.g. a manual re-run). */
  debounceMs?: number;
  /** Set by a full scan so its fan-out jobs can be counted as one run. */
  batchId?: string;
};

export type EnqueueScenarioScanResult = {
  jobId: string;
  /** True when an in-flight scan already covered this scenario (no new job). */
  coalesced: boolean;
  /** False when the scenario had no scannable documents. */
  enqueued: boolean;
};

const inFlightJob = async (scenarioType: ScenarioType, scenarioId: string) => {
  const col = scenarioType === "lead" ? aiScanJobs.leadId : aiScanJobs.caseId;
  const [row] = await db
    .select({ id: aiScanJobs.id })
    .from(aiScanJobs)
    .where(
      and(eq(col, scenarioId), inArray(aiScanJobs.status, ["queued", "running"])),
    )
    .limit(1);
  return row?.id ?? null;
};

/**
 * Enqueue an AI scan for a lead or case.
 *
 * Coalescing is the whole point: the ai_scan_jobs partial unique index allows
 * only one queued/running job per scenario, so a bulk upload of ten files
 * produces one scan, not ten. If a scan is already in flight we return it
 * rather than enqueueing a duplicate.
 *
 * NOTE (known limitation, to be handled by the result consumer): documents
 * uploaded WHILE a scan is running coalesce into that running job, which already
 * snapshotted its document set — so they may be missed until the next trigger.
 * The consumer should re-enqueue on completion if new document versions arrived
 * after `startedAt`.
 */
export const enqueueScenarioScan = async (
  params: EnqueueScenarioScanParams,
): Promise<EnqueueScenarioScanResult> => {
  const {
    organizationId,
    scenarioType,
    scenarioId,
    trigger,
    requestedByStaffId,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    batchId,
  } = params;

  // 1. Coalesce: already scanning this scenario?
  const existing = await inFlightJob(scenarioType, scenarioId);
  if (existing) return { jobId: existing, coalesced: true, enqueued: false };

  // 2. Build the request first, using the row id we're about to insert as the
  //    job identity, so nothing is written when there's nothing to scan.
  const jobId = randomUUID();
  const built = await buildScanRequest({
    organizationId,
    scenarioType,
    scenarioId,
    jobId,
  });
  if (!built) return { jobId, coalesced: false, enqueued: false };

  // 3. Claim the in-flight slot. A concurrent enqueue may have won the race —
  //    the partial unique index throws, and we coalesce onto the winner.
  try {
    await db.insert(aiScanJobs).values({
      id: jobId,
      organizationId,
      leadId: scenarioType === "lead" ? scenarioId : null,
      caseId: scenarioType === "case" ? scenarioId : null,
      status: "queued",
      trigger,
      requestedByStaffId: requestedByStaffId ?? null,
      batchId: batchId ?? null,
      documentCount: built.documentCount,
      cachedCount: built.cachedCount,
      runMetadata: {
        modelVersion: AI_MODEL_VERSION,
        promptVersion: effectivePromptVersion(),
      },
    });
  } catch (err) {
    const winner = await inFlightJob(scenarioType, scenarioId);
    if (winner) return { jobId: winner, coalesced: true, enqueued: false };
    throw err;
  }

  // 4. Enqueue the actual work; record the BullMQ id on the row.
  const queueJobId = await enqueueAiScanJob(jobId, built.payload, debounceMs);
  await db
    .update(aiScanJobs)
    .set({ queueJobId: queueJobId ?? null, updatedAt: new Date() })
    .where(eq(aiScanJobs.id, jobId));

  return { jobId, coalesced: false, enqueued: true };
};

/** Spacing between successive full-scan jobs, to spread execution load. */
const FULL_SCAN_SPACING_MS = 1500;
/**
 * Cap on a full-scan job's delay. Beyond this, jobs pile at the cap and the
 * worker drains them at its own concurrency (BullMQ backpressure). Kept well
 * under the reconciliation queued-timeout (1h) so a delayed job is never swept
 * as "never started" just before it fires.
 */
const MAX_FULL_SCAN_DELAY_MS = 20 * 60 * 1000; // 20 min

export type FullScanResult = {
  /** Shared id for the jobs this run fanned out into. */
  batchId?: string;
  scenarios: number;
  enqueued: number;
  coalesced: number;
  /** Scenarios with nothing scannable (no supported, checksummed documents). */
  skipped: number;
};

/**
 * Fan out a scan across every scenario in the org that has linked documents —
 * the "Run full scan" action.
 *
 * Rate-limited by spreading jobs over time (each successive job gets a larger
 * delay) so a firm with hundreds of matters doesn't hit Document AI / Gemini all
 * at once. The worker's own concurrency is the ultimate limiter; this just
 * smooths the arrival curve.
 */
export const enqueueFullScan = async (
  organizationId: string,
  requestedByStaffId?: string,
): Promise<FullScanResult> => {
  const [caseRows, leadRows] = await Promise.all([
    db
      .selectDistinct({ id: documentCaseLinks.caseId })
      .from(documentCaseLinks)
      .innerJoin(cases, eq(cases.id, documentCaseLinks.caseId))
      .innerJoin(documents, eq(documents.id, documentCaseLinks.documentId))
      .where(
        and(
          eq(cases.organizationId, organizationId),
          isNull(documentCaseLinks.archivedAt),
          eq(documents.status, "active"),
        ),
      ),
    db
      .selectDistinct({ id: leadDocumentLinks.leadId })
      .from(leadDocumentLinks)
      .innerJoin(leads, eq(leads.id, leadDocumentLinks.leadId))
      .innerJoin(documents, eq(documents.id, leadDocumentLinks.documentId))
      .where(
        and(
          eq(leads.organizationId, organizationId),
          isNull(leadDocumentLinks.archivedAt),
          eq(documents.status, "active"),
        ),
      ),
  ]);

  const scenarios: { type: ScenarioType; id: string }[] = [
    ...caseRows.map((r) => ({ type: "case" as const, id: r.id })),
    ...leadRows.map((r) => ({ type: "lead" as const, id: r.id })),
  ];

  const result: FullScanResult = {
    scenarios: scenarios.length,
    enqueued: 0,
    coalesced: 0,
    skipped: 0,
  };

  // One id shared by every job this scan fans out into, so the dashboard can
  // report what "the last scan" actually covered.
  const batchId = randomUUID();
  result.batchId = batchId;

  let index = 0;
  for (const scenario of scenarios) {
    const r = await enqueueScenarioScan({
      organizationId,
      scenarioType: scenario.type,
      scenarioId: scenario.id,
      trigger: "full_scan",
      requestedByStaffId,
      batchId,
      debounceMs: Math.min(index * FULL_SCAN_SPACING_MS, MAX_FULL_SCAN_DELAY_MS),
    });
    if (r.coalesced) result.coalesced += 1;
    else if (r.enqueued) result.enqueued += 1;
    else result.skipped += 1;
    index += 1;
  }

  return result;
};
