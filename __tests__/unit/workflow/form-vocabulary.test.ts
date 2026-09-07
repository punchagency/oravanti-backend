import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  assertVocabularyIsClosed,
  FIELDS,
  SECTIONS,
} from "../../../src/db/seeds/aos-case-questionnaire.seed";
import { formPdfService } from "../../../src/modules/workflow/form-pdf.service";

/**
 * The questionnaire and the form catalogue connect through shared field keys
 * and nothing else. A key that appears on one side and not the other does not
 * error at runtime — it silently fills nothing, which is the failure mode this
 * whole design has to be protected against.
 *
 * ─── What this file used to assert, and where it went ───────────────────────
 *
 * Most of it read files: `<code>.form-fields.json` against `forms/<code>.pdf`
 * against `form-editions.seed.ts`, and `<code>.field-sources.json` against both
 * ends of the wire. Those files are gone — a blank and its extraction live in
 * object storage now, and the wiring claim lives in `form_field_definitions`
 * where it is carried across editions instead of retyped. See
 * `src/modules/workflow/form-blank-storage.ts`.
 *
 * The invariants have not gone anywhere; they moved to where the data now is:
 *
 *   - "a form arrives as blank + extraction + edition + package row" is now
 *     structural. `addEdition` refuses a form that is not catalogued,
 *     `uploadBlank` refuses an edition that does not exist, and an edition with
 *     no blank is reported by `form-blanks-status` and at the end of
 *     `seedWorkflows` rather than being a thing to discover.
 *   - "every form has a title somebody wrote" is `addFormBody`, which requires
 *     one, against a NOT NULL column. There is no longer a placeholder that
 *     could reach a screen, because there is no longer a generated title.
 *   - "a box is wired to a datum the questionnaire asks for" is
 *     `bindToSchemaNodes`, which reports every key naming no node — a report
 *     over the whole database rather than over six files.
 *
 * What is left here is the half that is still declared in code, and it is the
 * half a test can still see: the questionnaire's own vocabulary.
 */
describe("AOS form field vocabulary", () => {
  it("asks nothing it has not declared", () => {
    // Throws with the offending keys named, so a failure says what to fix.
    expect(() => assertVocabularyIsClosed()).not.toThrow();
  });

  it("asks for every field exactly once", () => {
    const asked = SECTIONS.flatMap((s) => s.fields);
    const duplicates = asked.filter((f, i) => asked.indexOf(f) !== i);

    // The premise of the whole feature: a datum on five forms is asked once, so
    // there is one answer and one spelling. A duplicate question would defeat it.
    expect(duplicates).toEqual([]);
  });

  it("gives every required field a question", () => {
    const asked = new Set(SECTIONS.flatMap((s) => s.fields));
    const requiredButUnasked = Object.entries(FIELDS)
      .filter(([key, def]) => def.required && !asked.has(key))
      .map(([key]) => key);

    // A field USCIS requires that nothing asks for can only ever be filled by
    // hand, which is the situation this feature exists to remove.
    expect(requiredButUnasked).toEqual([]);
  });

  /*
    ─── Every box can be pointed at ──────────────────────────────────────────

    The mapper draws one rectangle per placement over the rendered page, so a
    box that resolves to none is a box an operator hunts for on the paper and
    never finds — and it fails silently, because a missing rectangle looks
    exactly like a part of the page with nothing on it.

    Percentages are checked as well as counted. A rectangle outside the page
    box lands off-screen or behind the pane, which is the same invisibility
    arriving by a different road.

    ─── Why this one is opt-in ───────────────────────────────────────────────

    It needs actual blanks, and there are no longer any in the repo. Rather than
    delete an assertion that has already caught a real bug once, it reads a
    directory named by `FORM_BLANKS_DIR` and skips when that is unset. Point it
    at a folder holding the blanks you want checked, and run it
    before re-extracting a form or after a pdf-lib upgrade:

        FORM_BLANKS_DIR=../blanks npm run test:unit -- form-vocabulary

    Skipping is the honest default. A suite that silently passed because it had
    nothing to read would be worse than one that says it did not run.
  */
  describe("box geometry", () => {
    const dir = process.env.FORM_BLANKS_DIR;
    const files = dir
      ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"))
      : [];

    const boxesByFile = new Map<
      string,
      Awaited<ReturnType<typeof formPdfService.listBoxesForBytes>>
    >();

    beforeAll(async () => {
      // One read per blank, shared: opening them per assertion is seconds
      // apiece and says nothing extra.
      for (const file of files) {
        boxesByFile.set(
          file,
          await formPdfService.listBoxesForBytes(
            readFileSync(path.join(dir!, file)),
          ),
        );
      }
    }, 120_000);

    const cases = files.length ? files : ["(FORM_BLANKS_DIR unset)"];
    const run = files.length ? it.each(cases) : it.skip.each(cases);

    run("locates every box on %s", (file) => {
      const unlocated = boxesByFile
        .get(file)!
        .filter((box) => box.placements.length === 0)
        .map((box) => box.name);

      expect(unlocated).toEqual([]);
    });

    run("keeps every box inside the page on %s", (file) => {
      const escaped = boxesByFile
        .get(file)!
        .flatMap((box) => box.placements.map((p) => ({ name: box.name, ...p })))
        .filter(
          (p) =>
            p.page < 0 ||
            p.left < 0 ||
            p.top < 0 ||
            p.width <= 0 ||
            p.height <= 0 ||
            // A hair of tolerance: these are floats off a PDF, and a box
            // flush with the trim edge lands on 100.0000001.
            p.left + p.width > 100.01 ||
            p.top + p.height > 100.01,
        )
        .map((p) => `${p.name} @ p${p.page} ${p.left},${p.top}`);

      expect(escaped).toEqual([]);
    });
  });
});
