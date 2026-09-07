/**
 * Where a form's blank and its extraction live, and how they are read back.
 *
 * ─── Why object storage rather than the repo ────────────────────────────────
 *
 * A blank used to be a file in `oravanti-be/forms/` and its extraction a JSON
 * file in `src/db/seeds/data/`, both reviewed in a pull request. The argument
 * for that was real — a blank is the same government document for every firm,
 * and reference data derived by a script still wants reading in a diff — but it
 * had one property that ended it: **adding a form, or an edition of one,
 * required a deploy.**
 *
 * That is the whole scaling wall. Three of the four things a form arrives as
 * were already self-service in the CRM — the definition, the case type, the
 * filing package — and only the blank forced a pull request. USCIS publishes a
 * new edition of a form on its own schedule, sometimes with no grace period,
 * and every one of those was a release. Meanwhile every edition is kept
 * forever, because filings already prepared on the old blank stay valid.
 *
 * So a blank is uploaded now, and everything downstream of it is derived on the
 * server: the boxes are read off the bytes, the catalogue is written from those
 * boxes, and the extraction is kept beside the blank as the record of what was
 * read. Nothing about a form is on the filesystem any more.
 *
 * ─── The key names the edition, not the form ────────────────────────────────
 *
 * `form_editions` already said why: USCIS reflows the page between editions and
 * the AcroForm field names move with it, so a blank and its mapping are only
 * ever valid for the one edition they were taken from. Two editions of the
 * I-485 coexist for months — the successor is announced long before it is
 * accepted — and they are two files.
 *
 * The `platform/` prefix is deliberate: these objects belong to Oravanti, not
 * to any firm, so nothing in a tenant-scoped sweep or deletion can reach them.
 */

import { createHash } from "node:crypto";

import { storageService } from "../../utils/storage/storage.service";

/** Everything the tier owns sits under this prefix. See the note above. */
const PREFIX = "platform/forms";

const folder = (formCode: string, editionDate: string) =>
  `${PREFIX}/${formCode.toLowerCase()}/${editionDate}`;

/** The official blank, exactly as USCIS publishes it. */
export const blankKey = (formCode: string, editionDate: string) =>
  `${folder(formCode, editionDate)}/blank.pdf`;

/**
 * What the extractor read off that blank.
 *
 * Kept because it is the record of a claim — these boxes, these labels, these
 * parts, read on this date — and because a re-extraction is worth diffing
 * against the last one. It is not read back to build the catalogue: the
 * database holds that, and a file that is loaded as well as stored is a second
 * source of truth waiting to disagree.
 */
export const extractionKey = (formCode: string, editionDate: string) =>
  `${folder(formCode, editionDate)}/form-fields.json`;

export const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Blank bytes, cached in memory.
 *
 * ─── Why this is not optional ───────────────────────────────────────────────
 *
 * Reading a blank used to be a local disk read, so nothing thought about how
 * often it happened. It happens a lot: every fill, every package render, every
 * preview, every box list, and the mapper's canvas on every page turn. Over
 * object storage each of those is a round trip for the better part of a
 * megabyte, and the I-485 is 1.2MB.
 *
 * The cache holds **bytes**, never a parsed `PDFDocument`. Filling mutates the
 * document — that is what filling is — so a shared one would leak one matter's
 * answers into the next request's render. Parsing is cheap beside the transfer;
 * sharing the parse is what is unsafe.
 *
 * Keyed on the object key, which already names the edition, and bounded by
 * total bytes rather than entry count because the entries differ by 3x in size.
 * Eviction is least-recently-used, which is the right shape here: a firm works
 * down one package, so the same six or seven blanks are wanted over and over.
 */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

const cache = new Map<string, Buffer>();
let cachedBytes = 0;

const touch = (key: string, bytes: Buffer) => {
  // Re-inserting moves the entry to the end of the Map's iteration order, which
  // is what makes the first entry the least recently used.
  cache.delete(key);
  cache.set(key, bytes);
  cachedBytes += bytes.byteLength;

  while (cachedBytes > MAX_CACHE_BYTES && cache.size > 1) {
    const [oldest, evicted] = cache.entries().next().value as [string, Buffer];
    cache.delete(oldest);
    cachedBytes -= evicted.byteLength;
  }
};

/** One blank's bytes, from the cache where possible. */
export const readBlank = async (key: string) => {
  const hit = cache.get(key);
  if (hit) {
    // Refresh its position; a hit is a use.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const bytes = await storageService.download(key);
  touch(key, bytes);
  return bytes;
};

/**
 * Store a blank and prime the cache with it.
 *
 * Priming matters more than it looks: the first thing that happens after an
 * upload is an extraction over the same bytes, and the CRM then renders the
 * blank to wire it. Fetching back what we just sent would be two round trips
 * for a buffer already in hand.
 */
export const writeBlank = async (key: string, bytes: Buffer) => {
  await storageService.upload({
    key,
    body: bytes,
    contentType: "application/pdf",
  });
  touch(key, bytes);
};

/** Store an extraction beside its blank. */
export const writeExtraction = async (key: string, value: unknown) =>
  storageService.upload({
    key,
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });

/**
 * Forget a cached blank.
 *
 * Called when an edition's blank is replaced. The key names the edition and not
 * the upload, so re-uploading a corrected blank reuses the key — without this,
 * the process would go on printing the file it replaced until it restarted.
 */
export const forgetBlank = (key: string) => {
  const held = cache.get(key);
  if (!held) return;
  cache.delete(key);
  cachedBytes -= held.byteLength;
};
