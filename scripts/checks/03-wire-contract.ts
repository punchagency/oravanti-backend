/**
 * Tier 1 — Postgres. The cross-service bridge.
 *
 * Builds a real scan request from a real scenario (not a hand-written literal)
 * and writes it to `fixtures/wire/scan-request.sample.json`. The Python side
 * then parses that file with its pydantic models — see
 * `oravanti-AI/scripts/checks/01_contract.py`. Run this, then that, and any
 * drift between `src/modules/ai-scan/contract.ts` and `oravanti_ai/core/types.py`
 * surfaces immediately instead of at the first real scan.
 *
 * It also parses `fixtures/wire/scan-result.sample.json` (emitted by the Python
 * check) so the reverse direction is covered.
 */
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { AiScanResultJob } from "../../src/modules/ai-scan/contract";
import { buildScanRequest } from "../../src/modules/ai-scan/scan-payload";
import {
  AI_MODEL_VERSION,
  DOCUMENT_TYPE_SLUGS,
  effectivePromptVersion,
} from "../../src/modules/ai-scan/vocabulary";
import {
  check,
  checkEqual,
  report,
  section,
  withOrgContext,
  withTempFixture,
} from "./_bootstrap";

const WIRE_DIR = join(__dirname, "..", "..", "fixtures", "wire");

const main = async () => {
  await withTempFixture(
    {
      docs: [
        {
          title: "Passport",
          analysis: {
            documentTypeSlug: "passport",
            extractedFields: { full_name: "Ana Silva", date_of_birth: "1990-04-17" },
            hasPhoto: true,
          },
        },
        { title: "Utility Bill" }, // no analysis → must be scanned, not cached
      ],
    },
    async (fx) => {
      await withOrgContext(fx.organizationId, fx.userId, async () => {
        section("buildScanRequest — request payload");

        const jobId = randomUUID();
        const built = await buildScanRequest({
          organizationId: fx.organizationId,
          scenarioType: "lead",
          scenarioId: fx.leadId,
          jobId,
        });

        check("a request was built", built !== null);
        if (!built) return;

        const p = built.payload;
        checkEqual("schema_version is 1", p.schema_version, 1);
        checkEqual("job_id echoes the caller's id", p.job_id, jobId);
        checkEqual("organization_id is set", p.organization_id, fx.organizationId);
        checkEqual("model_version matches vocabulary", p.model_version, AI_MODEL_VERSION);
        checkEqual(
          "prompt_version folds in the slug hash",
          p.prompt_version,
          effectivePromptVersion(),
        );
        checkEqual(
          "allowed_slugs is the full vocabulary",
          [...p.allowed_slugs].sort(),
          [...DOCUMENT_TYPE_SLUGS].sort(),
        );
        checkEqual("both documents included", p.documents.length, 2);
        checkEqual("documentCount agrees", built.documentCount, 2);

        const passport = p.documents.find((d) => d.checksum === fx.docs[0].checksum);
        const bill = p.documents.find((d) => d.checksum === fx.docs[1].checksum);

        check("analysed document carries cached facts", passport?.cached_facts != null);
        check("unanalysed document has no cached facts", bill?.cached_facts === null);
        checkEqual("cachedCount reflects the cache hit", built.cachedCount, 1);
        checkEqual(
          "cached facts carry the extracted fields",
          passport?.cached_facts?.extracted_fields.full_name,
          "Ana Silva",
        );

        for (const d of p.documents) {
          check(
            `document ${d.id.slice(0, 8)} has a storage path and mime type`,
            !!d.storage_path && !!d.mime_type,
            d,
          );
        }

        section("wire fixture — emit for the Python side");

        mkdirSync(WIRE_DIR, { recursive: true });
        const requestPath = join(WIRE_DIR, "scan-request.sample.json");
        writeFileSync(requestPath, `${JSON.stringify(p, null, 2)}\n`, "utf8");
        console.log(`  wrote ${requestPath}`);
        check("request sample is valid JSON round-trip", (() => {
          const parsed = JSON.parse(readFileSync(requestPath, "utf8"));
          return parsed.job_id === jobId;
        })());

        section("wire fixture — consume the Python side's result");

        const resultPath = join(WIRE_DIR, "scan-result.sample.json");
        if (!existsSync(resultPath)) {
          console.log(
            `  \x1b[33mSKIP\x1b[0m ${resultPath} not present — run the Python check 01_contract.py first`,
          );
        } else {
          const result = JSON.parse(
            readFileSync(resultPath, "utf8"),
          ) as AiScanResultJob;

          checkEqual("result schema_version is 1", result.schema_version, 1);
          check(
            "status is a known value",
            ["complete", "failed"].includes(result.status),
            result.status,
          );
          checkEqual("model_version agrees", result.model_version, AI_MODEL_VERSION);
          check("documents is an array", Array.isArray(result.documents));
          check("conflicts is an array", Array.isArray(result.conflicts));
          check(
            "photo_comparisons is an array",
            Array.isArray(result.photo_comparisons),
          );
          check("errors is an array", Array.isArray(result.errors));

          for (const d of result.documents) {
            check(
              `fact ${d.id?.slice(0, 8) ?? "?"} has the required keys`,
              typeof d.checksum === "string" &&
                typeof d.document_type === "string" &&
                typeof d.extracted_fields === "object" &&
                typeof d.has_photo === "boolean" &&
                typeof d.authenticity?.verdict === "string",
              d,
            );
          }
        }
      });
    },
  );

  await report();
};

void main();
