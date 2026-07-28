/**
 * Tier 2 — the full cross-language round trip. Postgres + Redis.
 *
 *   npm run check 06-roundtrip
 *
 * The one check that exercises the actual seam between the two services:
 *
 *   backend enqueues on `ai-scan`
 *     → Python worker (real `build_handler`, stubbed AI clients) consumes it
 *     → publishes to `ai-scan-results`
 *     → backend's real result worker consumes and persists
 *
 * The Python side is spawned as a subprocess, so this is one command rather
 * than a three-terminal dance. Point `ORAVANTI_AI` at the AI service repo if it
 * is not a sibling directory.
 *
 * No Google or R2 calls happen: the Python bridge stubs the pipeline's three
 * billable collaborators. What is under test here is the transport, the
 * payload contract across languages, and the persistence that follows —
 * not extraction quality.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { aiScanJobs } from "../../src/db/schema/ai-scan-jobs";
import { documentAnalyses } from "../../src/db/schema/document-analyses";
import { enqueueScenarioScan } from "../../src/modules/ai-scan/scan-producer";
import { effectivePromptVersion } from "../../src/modules/ai-scan/vocabulary";
import { aiScanQueue } from "../../src/queue/queues";
import { createAiScanResultWorker } from "../../src/queue/workers/ai-scan-result.worker";
import {
  check,
  checkEqual,
  report,
  section,
  withOrgContext,
  withTempFixture,
} from "./_bootstrap";
import { skipIfExternalAiScanConsumer } from "./_queue-guard";

const AI_REPO =
  process.env.ORAVANTI_AI ??
  join(__dirname, "..", "..", "..", "oravanti-AI");

const BRIDGE = join("scripts", "checks", "08_queue_bridge.py");
const TIMEOUT_MS = 45_000;

/** Spawn the Python bridge: consumes one job, replies, exits. */
const startBridge = (): { done: Promise<number>; kill: () => void } => {
  const python = existsSync(join(AI_REPO, "venv", "bin", "python"))
    ? join(AI_REPO, "venv", "bin", "python")
    : "python3";

  const child = spawn(python, [BRIDGE, "--bridge"], {
    cwd: AI_REPO,
    env: { ...process.env, PYTHONPATH: join("scripts", "checks") },
  });

  child.stdout.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => console.log(`       │ ${l}`)),
  );
  child.stderr.on("data", (d) => {
    const text = String(d).trimEnd();
    if (text) console.log(`       │ ${text.split("\n").slice(-3).join("\n       │ ")}`);
  });

  return {
    done: new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1))),
    kill: () => child.kill("SIGKILL"),
  };
};

/** Poll until `fn` returns a value, or give up. */
const waitFor = async <T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = TIMEOUT_MS,
): Promise<T | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
};

const main = async () => {
  if (!existsSync(join(AI_REPO, BRIDGE))) {
    console.error(
      `Cannot find the AI service bridge at ${join(AI_REPO, BRIDGE)}.\n` +
        `Set ORAVANTI_AI to the AI service repo.`,
    );
    process.exit(1);
  }

  // This check spawns its own ai-scan consumer and needs the queue to itself.
  await skipIfExternalAiScanConsumer("06-roundtrip");

  await withTempFixture({ docs: [{ title: "Passport" }] }, async (fx) => {
    const doc = fx.docs[0];
    let jobId = "";
    const resultWorker = createAiScanResultWorker();
    const bridge = startBridge();

    try {
      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("backend → ai-scan");

        const enqueued = await enqueueScenarioScan({
          organizationId: fx.organizationId,
          scenarioType: "lead",
          scenarioId: fx.leadId,
          trigger: "manual",
          debounceMs: 0,
        });
        jobId = enqueued.jobId;

        check("a scan was enqueued", enqueued.enqueued);
        check("the job is on the queue", !!(await aiScanQueue.getJob(jobId)));
        console.log(`       job ${jobId}`);

        section("python worker → ai-scan-results");

        const exitCode = await Promise.race([
          bridge.done,
          new Promise<number>((r) => setTimeout(() => r(-1), TIMEOUT_MS)),
        ]);
        checkEqual("the python bridge completed cleanly", exitCode, 0);

        section("backend result worker → persistence");

        const job = await waitFor(async () => {
          const [row] = await db
            .select()
            .from(aiScanJobs)
            .where(eq(aiScanJobs.id, jobId));
          return row && row.status !== "queued" && row.status !== "running"
            ? row
            : null;
        });

        check("the job reached a terminal status", !!job, job?.status);
        checkEqual("status is complete", job?.status, "complete");
        check("completedAt was stamped", !!job?.completedAt);

        const analyses = await db
          .select()
          .from(documentAnalyses)
          .where(eq(documentAnalyses.checksum, doc.checksum));

        checkEqual("the analysis was cached", analyses.length, 1);
        checkEqual("cached as complete", analyses[0]?.status, "complete");
        checkEqual(
          "cached under the prompt version the backend sent",
          analyses[0]?.promptVersion,
          effectivePromptVersion(),
        );
        checkEqual(
          "the document type survived the round trip",
          analyses[0]?.documentTypeSlug,
          "passport",
        );

        const fields = analyses[0]?.extractedFields as Record<string, string>;
        checkEqual(
          "extracted fields survived the round trip",
          fields?.full_name,
          "Queue Bridge",
        );

        section("end to end");

        check(
          "a job enqueued by Node was processed by Python and persisted by Node",
          job?.status === "complete" && analyses.length === 1,
        );
      });
    } finally {
      bridge.kill();
      await resultWorker.close().catch(() => {});
      if (jobId) {
        await aiScanQueue
          .getJob(jobId)
          .then((j) => j?.remove())
          .catch(() => {});
      }
      await db
        .delete(aiScanJobs)
        .where(eq(aiScanJobs.organizationId, fx.organizationId));
      await db
        .delete(documentAnalyses)
        .where(eq(documentAnalyses.checksum, doc.checksum));
      await aiScanQueue.close().catch(() => {});
    }
  });

  await report();
};

void main();
