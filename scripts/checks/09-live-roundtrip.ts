/**
 * Tier 3 — the whole system, live. Billable (~3 model calls).
 *
 *   npm run check 09-live-roundtrip -- --live
 *
 * Every other check stubs something. This one stubs nothing:
 *
 *   a real document uploaded to R2
 *     → backend enqueues on `ai-scan`
 *     → the real Python worker (`oravanti-ai-worker`) picks it up
 *     → real Document AI OCR + real Gemini extraction
 *     → result published to `ai-scan-results`
 *     → backend's real result worker persists it
 *     → assertions run against genuinely extracted fields
 *
 * `06-roundtrip` proves the transport with stubs; `07_live_scan.py` proves the
 * model calls without the queue. This is the only check where both are true at
 * once, which is the configuration production actually runs.
 *
 * Everything uploaded to R2 is removed in a `finally`, including the OCR
 * artifact the worker writes.
 */
import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { db, systemDb } from "../../src/db/client";
import { aiScanJobs } from "../../src/db/schema/ai-scan-jobs";
import { documentAnalyses } from "../../src/db/schema/document-analyses";
import { documentVersions } from "../../src/db/schema/documents";
import { enqueueScenarioScan } from "../../src/modules/ai-scan/scan-producer";
import { aiScanQueue } from "../../src/queue/queues";
import { createAiScanResultWorker } from "../../src/queue/workers/ai-scan-result.worker";
import { storageService } from "../../src/utils/storage/storage.service";
import {
  check,
  checkEqual,
  report,
  section,
  withOrgContext,
  withTempFixture,
} from "./_bootstrap";

const AI_REPO =
  process.env.ORAVANTI_AI ?? join(__dirname, "..", "..", "..", "oravanti-AI");
const SAMPLE = join(AI_REPO, "samples", "passport", "America.png");
const TIMEOUT_MS = 180_000;

const startWorker = () => {
  const python = existsSync(join(AI_REPO, "venv", "bin", "python"))
    ? join(AI_REPO, "venv", "bin", "python")
    : "python3";

  const child = spawn(python, ["-m", "oravanti_ai.adapters.worker"], {
    cwd: AI_REPO,
  });
  const log = (d: Buffer) =>
    String(d)
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .forEach((l) => console.log(`       │ ${l}`));
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  return child;
};

const waitFor = async <T>(fn: () => Promise<T | null | undefined>) => {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
};

const main = async () => {
  if (!process.argv.includes("--live") && process.env.ORAVANTI_LIVE !== "1") {
    console.log(
      "This check runs real Document AI, Gemini and R2 calls (billable).\n" +
        "Re-run with `-- --live`, or set ORAVANTI_LIVE=1, to proceed.",
    );
    await report();
    return;
  }
  if (!existsSync(SAMPLE)) {
    console.error(`Sample document not found: ${SAMPLE}\nSet ORAVANTI_AI.`);
    process.exit(1);
  }

  const bytes = readFileSync(SAMPLE);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const key = `ai-artifacts/live-roundtrip-${Date.now()}.png`;

  await withTempFixture({ docs: [{ title: "Passport" }] }, async (fx) => {
    const doc = fx.docs[0];
    let worker: ReturnType<typeof startWorker> | null = null;
    const resultWorker = createAiScanResultWorker();
    let jobId = "";

    try {
      section("upload the real document to R2");

      await storageService.upload({
        key,
        body: bytes,
        contentType: "image/png",
      });
      check("sample uploaded", true);
      console.log(`       ${key} (${bytes.length} bytes, sha256 ${checksum.slice(0, 12)}…)`);

      // Point the fixture's version at the real object so the worker's
      // read_verified finds bytes that hash to the checksum we send.
      await systemDb
        .update(documentVersions)
        .set({ filePath: key, checksum, mimeType: "image/png" })
        .where(eq(documentVersions.id, doc.versionId));

      worker = startWorker();

      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("backend → ai-scan");

        const enq = await enqueueScenarioScan({
          organizationId: fx.organizationId,
          scenarioType: "lead",
          scenarioId: fx.leadId,
          trigger: "manual",
          debounceMs: 0,
        });
        jobId = enq.jobId;
        check("a scan was enqueued", enq.enqueued);
        console.log(`       job ${jobId}`);

        section("the real worker processes it (OCR + Gemini)");

        const job = await waitFor(async () => {
          const [row] = await db
            .select()
            .from(aiScanJobs)
            .where(eq(aiScanJobs.id, jobId));
          return row && (row.status === "complete" || row.status === "failed")
            ? row
            : null;
        });

        check("the job reached a terminal status within the timeout", !!job, job?.status);
        checkEqual("status is complete", job?.status, "complete");
        if (job?.error) console.log(`       error: ${job.error}`);

        section("genuinely extracted facts were persisted");

        const [analysis] = await systemDb
          .select()
          .from(documentAnalyses)
          .where(eq(documentAnalyses.checksum, checksum));

        check("an analysis was cached", !!analysis);
        checkEqual("cached as complete", analysis?.status, "complete");
        check(
          "a document type was classified",
          !!analysis?.documentTypeSlug,
          analysis?.documentTypeSlug,
        );
        console.log(`       classified as: ${analysis?.documentTypeSlug}`);

        const fields = (analysis?.extractedFields ?? {}) as Record<string, string>;
        console.log(`       fields: ${Object.keys(fields).sort().join(", ")}`);
        check("fields were extracted from the real document", Object.keys(fields).length > 0);
        check(
          "all extracted values are strings",
          Object.values(fields).every((v) => typeof v === "string"),
        );
        check("a photo was detected on the passport", analysis?.hasPhoto === true);
        check(
          "an authenticity verdict was recorded",
          !!analysis?.authenticityVerdict,
          analysis?.authenticityVerdict,
        );
        check(
          "the OCR artifact key was recorded",
          !!analysis?.ocrArtifactKey,
          analysis?.ocrArtifactKey,
        );

        section("end to end");

        check(
          "a real document went through Node → Redis → Python → GCP → Redis → Node → Postgres",
          job?.status === "complete" && Object.keys(fields).length > 0,
        );
      });
    } finally {
      worker?.kill("SIGTERM");
      await resultWorker.close().catch(() => {});
      if (jobId) {
        await aiScanQueue
          .getJob(jobId)
          .then((j) => j?.remove())
          .catch(() => {});
      }
      const [analysis] = await systemDb
        .select()
        .from(documentAnalyses)
        .where(eq(documentAnalyses.checksum, checksum));
      const artifacts = [key, analysis?.ocrArtifactKey].filter(Boolean) as string[];
      await storageService.remove(artifacts).catch((e) => console.error("cleanup:", e));
      console.log(`\n  removed ${artifacts.length} R2 object(s)`);

      await systemDb
        .delete(aiScanJobs)
        .where(eq(aiScanJobs.organizationId, fx.organizationId));
      await systemDb
        .delete(documentAnalyses)
        .where(eq(documentAnalyses.checksum, checksum));
      await aiScanQueue.close().catch(() => {});
    }
  });

  await report();
};

void main();
