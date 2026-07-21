import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { aiScanJobs } from "../../db/schema/ai-scan-jobs";
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
