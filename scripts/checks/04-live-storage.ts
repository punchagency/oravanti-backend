/**
 * Tier 3 — live Cloudflare R2 from the backend side. Billable (trivially).
 *
 *   npm run check 04-live-storage -- --live
 *
 * The backend uploads documents; the Python worker reads them back by key and
 * verifies them against the checksum the backend computed. This check covers
 * the backend half of that contract, plus the checksum agreement itself — if
 * the two services ever disagreed on how a document hashes, every scan would
 * fail the `read_verified` guard.
 *
 * Every object it writes is removed in a `finally`.
 */
import { randomUUID } from "crypto";
import { computeChecksum } from "../../src/modules/documents/document-ingest";
import { storageService } from "../../src/utils/storage/storage.service";
import { check, checkEqual, report, section } from "./_bootstrap";

/**
 * sha256("oravanti checksum parity probe") — the same constant is asserted by
 * the Python side. Hard-coded rather than computed here on purpose: computing
 * it with the same library it is meant to validate would prove nothing.
 */
const PARITY_INPUT = "oravanti checksum parity probe";
const PARITY_SHA256 =
  "136b9637b7199847cd21cd0ae3e381874c945ada43100cc4ff142d32b2d4d61e";

const main = async () => {
  if (!process.argv.includes("--live") && process.env.ORAVANTI_LIVE !== "1") {
    console.log(
      "This check calls Cloudflare R2 for real (billable).\n" +
        "Re-run with `-- --live`, or set ORAVANTI_LIVE=1, to proceed.",
    );
    await report();
    return;
  }

  const runId = randomUUID().slice(0, 12);
  const key = `ai-artifacts/backend-live-check-${runId}.bin`;
  const body = Buffer.from(`backend live storage check ${runId}\n`, "utf8");
  let uploaded = false;

  try {
    section("upload → download round trip");

    await storageService.upload({
      key,
      body,
      contentType: "application/octet-stream",
    });
    uploaded = true;
    check("upload resolved", true);

    const downloaded = await storageService.download(key);
    check("download returns a Buffer", Buffer.isBuffer(downloaded));
    check("bytes survive the round trip", downloaded.equals(body), {
      sent: body.length,
      got: downloaded.length,
    });

    section("checksum — the identity the Python side verifies against");

    const checksum = computeChecksum(body);
    check("checksum is 64 hex chars (sha256)", /^[0-9a-f]{64}$/.test(checksum), checksum);
    checkEqual(
      "the downloaded bytes hash to the same checksum",
      computeChecksum(downloaded),
      checksum,
    );

    // Cross-service parity: the Python worker rejects any document whose bytes
    // do not hash to the checksum sent with the job, so the two services must
    // agree byte-for-byte on the digest. The expected value is a fixed constant
    // verified out of band, not recomputed here.
    checkEqual(
      "computeChecksum agrees with the shared sha256 constant",
      computeChecksum(Buffer.from(PARITY_INPUT, "utf8")),
      PARITY_SHA256,
    );

    section("presigned download URL");

    const url = await storageService.getSignedDownloadUrl(key, 300);
    check("a URL was issued", typeof url === "string" && url.startsWith("http"), url?.slice(0, 40));
    check("the URL is presigned", url.includes("X-Amz-Signature"), url.slice(0, 60));
    check("the URL targets the object key", url.includes(encodeURIComponent(key).replace(/%2F/g, "/")), key);

    section("remove");

    await storageService.remove([key]);
    uploaded = false;

    let downloadAfterRemoveFailed = false;
    try {
      await storageService.download(key);
    } catch {
      downloadAfterRemoveFailed = true;
    }
    check("the object is gone after remove", downloadAfterRemoveFailed);

    check(
      "removing an absent key does not throw",
      await storageService
        .remove([`ai-artifacts/definitely-absent-${runId}.bin`])
        .then(() => true)
        .catch(() => false),
    );
  } finally {
    if (uploaded) {
      await storageService.remove([key]).catch((err) => {
        console.error(`  cleanup failed for ${key}:`, err);
      });
    }
  }

  await report();
};

void main();
