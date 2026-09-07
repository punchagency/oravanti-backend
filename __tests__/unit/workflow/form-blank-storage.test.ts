/*
  The blank cache, which is the one part of the storage move that can be wrong
  without anything saying so.

  Reading a blank used to be a local disk read. It is now a network round trip
  for up to a megabyte and a half, on every fill, every package render, every
  preview, every box list, and the mapper's canvas on every page turn — so a
  cache is not an optimisation here, it is what keeps the Forms tab usable.

  Both of its failure modes are silent:

  - a miss that should have been a hit is only slow, and slow is what everyone
    already expects of a PDF;
  - a hit that should have been a miss serves the *previous* blank, which means
    a form printed from a document USCIS no longer accepts, with a correct-
    looking edition date on the screen beside it.

  The second is why `forgetBlank` exists and why it is asserted here.
*/

const download = jest.fn<Promise<Buffer>, [string]>();
const upload = jest.fn<Promise<void>, [unknown]>();

jest.mock("../../../src/utils/storage/storage.service", () => ({
  storageService: {
    get download() {
      return download;
    },
    get upload() {
      return upload;
    },
  },
}));

import {
  blankKey,
  extractionKey,
  forgetBlank,
  readBlank,
  sha256,
  writeBlank,
} from "../../../src/modules/workflow/form-blank-storage";

const bytes = (fill: string, size = 8) => Buffer.alloc(size, fill);

describe("blank object keys", () => {
  it("names the edition, not just the form", () => {
    /*
      Two editions of one form coexist for months — USCIS announces the
      successor long before it starts accepting it — and they are two different
      documents whose AcroForm names have moved. A key per form code would have
      the newer upload overwrite the older blank, and every mapping made against
      the old one would then point into the wrong file.
    */
    expect(blankKey("I-485", "2025-01-20")).toBe(
      "platform/forms/i-485/2025-01-20/blank.pdf",
    );
    expect(blankKey("I-485", "2026-09-18")).toBe(
      "platform/forms/i-485/2026-09-18/blank.pdf",
    );
  });

  it("keeps the extraction beside the blank it was read from", () => {
    expect(extractionKey("I-130", "2024-04-01")).toBe(
      "platform/forms/i-130/2024-04-01/form-fields.json",
    );
  });

  it("puts everything under a platform prefix", () => {
    // These objects belong to Oravanti and to no firm, so nothing in a
    // tenant-scoped sweep or deletion can be allowed to reach them.
    expect(blankKey("I-864", "2024-10-17")).toMatch(/^platform\//);
  });
});

describe("reading a blank", () => {
  beforeEach(() => {
    // Each test works on its own key, so no state leaks between them without
    // needing the module registry reset.
    download.mockReset();
    upload.mockReset();
  });

  it("fetches once and serves the rest from memory", async () => {
    const key = blankKey("I-130", "2024-04-01");
    download.mockResolvedValue(bytes("a"));

    const first = await readBlank(key);
    const second = await readBlank(key);

    expect(download).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("serves the bytes an upload put there, without fetching them back", async () => {
    const key = blankKey("I-131", "2024-06-17");
    const uploaded = bytes("b");

    await writeBlank(key, uploaded);
    const read = await readBlank(key);

    // The first thing that happens after an upload is an extraction over the
    // same bytes, and the CRM then renders the blank to wire it. Fetching back
    // what was just sent is two round trips for a buffer already in hand.
    expect(read).toBe(uploaded);
    expect(download).not.toHaveBeenCalled();
  });

  it("re-fetches after the blank behind a key is forgotten", async () => {
    const key = blankKey("I-765", "2025-08-21");
    const corrected = bytes("d");
    download.mockResolvedValueOnce(bytes("c")).mockResolvedValueOnce(corrected);

    await readBlank(key);
    forgetBlank(key);
    const again = await readBlank(key);

    /*
      This is the one that matters. Replacing a corrected blank reuses the key —
      the key names the edition, not the upload — so without the eviction the
      process would go on printing the file it replaced until it restarted, and
      nothing on any screen would disagree.
    */
    expect(download).toHaveBeenCalledTimes(2);
    expect(again).toBe(corrected);
  });

  it("forgetting a key nothing holds is not an error", async () => {
    // Called on every upload, including the first one for an edition.
    expect(() => forgetBlank(blankKey("I-864", "2024-10-17"))).not.toThrow();
  });
});

describe("checksums", () => {
  it("is stable for the same bytes and different for others", () => {
    /*
      This is what makes a re-upload of the same file a no-op rather than a run
      that restates every row with what it already says and stamps a new
      `extractedAt` — an audit trail claiming work that did not happen.
    */
    expect(sha256(bytes("a"))).toBe(sha256(bytes("a")));
    expect(sha256(bytes("a"))).not.toBe(sha256(bytes("b")));
    expect(sha256(bytes("a"))).toHaveLength(64);
  });
});
