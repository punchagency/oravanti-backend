/**
 * Read a form's field catalogue off its blank PDF.
 *
 * ─── Why this is a service and not a script ─────────────────────────────────
 *
 * It was `scripts/extract-form-fields.ts`, run by a developer against a file in
 * the repo, writing a JSON file that was then reviewed and committed. The two
 * steps were deliberate: a form's catalogue is reference data, and reference
 * data derived by a script still wants reading in a diff before it reaches
 * anyone's matter.
 *
 * What ended that arrangement is that it made **adding a form a deploy**, and
 * so was every new USCIS edition of a form already catalogued. See
 * `form-blank-storage.ts` for the whole argument. Extraction now runs on the
 * server over bytes that have just been uploaded, and the review step it used
 * to get from a pull request is `form-catalogue-import.service.ts`'s diff,
 * which an operator confirms before anything is written.
 *
 * The logic below is unchanged from the script — this is the same extractor,
 * moved. It matters that it is only in one place: two extractors reading one
 * blank differently is precisely the failure the old hand-written `FORMS`
 * constant had, and it is not one a test can see.
 *
 * ─── Where the wording comes from ───────────────────────────────────────────
 *
 * From the form. Every box on a USCIS blank carries a `/TU` tooltip — the
 * Section 508 alternate description — and it is the printed question, heading
 * and item number included:
 *
 *     Part 9. General Eligibility and Inadmissibility Grounds. 13. Have you
 *     EVER violated the terms or conditions of your nonimmigrant status?
 *
 * So a field's label is *that*, not a phrase reconstructed from the box's name.
 * The name is used only where a tooltip is missing, and for the field key —
 * see `labelFor` below. Nothing is paraphrased or shortened: somebody checking
 * the screen against the paper has to be reading the same sentence.
 *
 * The tooltips settle things the names cannot. On the I-485 the boxes named
 * `Pt8…` are in printed **Part 9**; a part table written from the box numbers
 * is wrong from Part 3 onwards, and only the tooltip knows.
 *
 * ─── What it deliberately does not do ───────────────────────────────────────
 *
 * It does not invent shared vocabulary. A generated key is form-local —
 * `i485.pt1.1_family_name` — and says only where the box is. Deciding that a
 * box holds `beneficiary.family_name`, the same datum the questionnaire asks
 * for and five other forms print, is a judgement no name-matcher should make
 * on its own: getting it wrong points a statutory form at the wrong answer.
 * That decision is made by a person, in the CRM's mapper, and the import
 * respects it — see that service's header.
 */

import { formPdfService } from "./form-pdf.service";
import { partTitle } from "./form-parts";
import {
  fieldKeyFor,
  humanLabel,
  inferType,
  leafName,
  parseBoxName,
  parseTooltip,
  sameAnswer,
  tidyHeading,
  type ParsedBoxName,
  type QuestionType,
} from "./pdf-field-naming";

type Box = Awaited<ReturnType<typeof formPdfService.listBoxesForBytes>>[number];

export type ExtractedField = {
  fieldKey: string;
  label: string;
  partLabel: string;
  type: QuestionType;
  orderIndex: number;
  config: Record<string, unknown>;
  /**
   * Every box this field prints into, and which answer reaches each.
   *
   * A list rather than one name, because a choice is not one box. USCIS prints
   * a checkbox per option — `Pt1Line1_Spouse[0]`, `Pt1Line1_Parent[0]`, … — so
   * "which box?" only has an answer once you know *what was answered*. A text
   * or dropdown field has exactly one entry, with a null value.
   */
  mappings: { value: string | null; pdfFieldName: string }[];
};

export type Extraction = {
  fields: ExtractedField[];
  /** Boxes whose part could be recovered from neither name nor tooltip. */
  skipped: string[];
  /** Fields that fell back to their box name for a label. */
  noTooltip: string[];
  /** Every part heading found, in the order the form prints them. */
  parts: string[];
};

/**
 * Where a field sits on the paper, kept only long enough to sort by.
 *
 * The boxes do not come off the document in reading order — Part 1 item 4
 * arrives after item 10 on the I-485 — and a catalogue that lists a form's
 * items out of order is worse than useless to somebody checking it against the
 * printed page.
 */
type Placement = { part: number; line: number; suffix: string; seq: number };

/**
 * The heading each part is given, decided by what its own boxes say.
 *
 * A tooltip's heading often carries a sub-heading too — "Information About You
 * (Petitioner). Your Full Name" — and a handful are simply wrong, USCIS having
 * pasted a neighbouring part's title onto a stray box. Taking the *most common*
 * heading among a part's boxes settles both: on the I-485's Part 6, forty-two
 * boxes say "Information About Your Marital History" and six say the
 * interpreter's heading.
 */
const partHeadings = (formCode: string, boxes: Box[]) => {
  const votes = new Map<number, Map<string, number>>();

  for (const box of boxes) {
    const { part, title } = parseTooltip(box.tooltip);
    if (part === null || !title) continue;
    // Only the heading itself votes, not the sub-headings under it.
    const heading = tidyHeading(title.split(/\.\s+/)[0]);
    if (!votes.has(part)) votes.set(part, new Map());
    const counts = votes.get(part)!;
    counts.set(heading, (counts.get(heading) ?? 0) + 1);
  }

  const headings = new Map<number, string>();
  for (const [part, counts] of votes) {
    const [winner] = [...counts].sort((a, b) => b[1] - a[1]);
    headings.set(part, `Part ${part}. ${winner[0]}`);
  }
  // A hand-written override still wins where one exists, and a part with no
  // tooltips at all falls back to it.
  return (part: number) => headings.get(part) ?? partTitle(formCode, part);
};

/**
 * The form's own words for this box, falling back to its name.
 *
 * The fallback is not decoration: 4 boxes on the I-130 and 78 on the I-485 have
 * a tooltip that names no part, and a few have none worth reading. Those get a
 * label built from the name — worse, and clearly marked as such by being the
 * only labels on the form that read like identifiers.
 */
const labelFor = (box: Box, parsed: ParsedBoxName | null) => {
  const tooltip = parseTooltip(box.tooltip);
  if (tooltip.question) return tooltip.question;
  // A tooltip with no question left after the heading is still better than a
  // name, as long as it says something.
  if (!tooltip.part && tooltip.question === "" && box.tooltip) {
    return box.tooltip;
  }
  return parsed ? humanLabel(parsed.line, parsed.tail) : leafName(box.name);
};

/**
 * The catalogue of one blank, read off the bytes.
 *
 * Takes bytes rather than a form code and a path, so it can run against a file
 * that has just arrived over the wire and has nothing written down about it
 * yet. `formCode` is needed only to build field keys and to look up a
 * hand-written part-heading override.
 */
export const extractForm = async (
  formCode: string,
  bytes: Buffer,
): Promise<Extraction> => {
  const boxes = await formPdfService.listBoxesForBytes(bytes);
  const headingFor = partHeadings(formCode, boxes);

  const fields: (ExtractedField & { at: Placement })[] = [];
  const skipped: string[] = [];
  const noTooltip: string[] = [];
  /**
   * Checkbox halves collapse into the question they belong to. `Pt8Line13_YesNo`
   * is two boxes and one question, and cataloguing them separately would ask a
   * paralegal to answer it twice.
   */
  type ChoiceGroup = {
    part: number;
    line: string | null;
    /** The question, with the per-widget "Select X." already off it. */
    label: string;
    /**
     * One entry per box in the group, each with the answer that marks it.
     * Keeping only the first of these is what made every other option on
     * every choice unreachable.
     */
    members: { value: string; box: string }[];
    at: Placement;
  };

  /**
   * Groups keyed by question, but a *list* of them per question.
   *
   * Because a form can ask the same question several times over. Part 9 items
   * 65 and 66 of the I-485 are four-row tables — `Pt9Line65_Row1_YesNo`
   * through `Row4` — every row carrying the same item number and the same
   * tooltip. One group per question folded all four rows together and dropped
   * fifteen boxes on the floor.
   *
   * A box whose answer the current group already holds cannot belong to it, so
   * it starts the next one. That needs no knowledge of rows or tables: two
   * boxes claiming the same answer are, by definition, two different questions.
   */
  const choiceGroups = new Map<string, ChoiceGroup[]>();
  const usedKeys = new Set<string>();

  boxes.forEach((box, seq) => {
    const parsed = parseBoxName(box.name);
    if (!parsed) {
      skipped.push(leafName(box.name));
      return;
    }

    const tooltip = parseTooltip(box.tooltip);
    if (!tooltip.question) noTooltip.push(leafName(box.name));

    // The printed part beats the box's own numbering where they disagree, and
    // on the I-485 they disagree from Part 3 onwards.
    //
    // Either source may be missing — the I-765 names its boxes without a part,
    // and some boxes carry no tooltip — but not both, or there is nowhere to
    // file the field. That is a skip rather than a guess: a field placed in an
    // invented part is worse than one reported as unplaceable.
    const part = tooltip.part ?? parsed.part;
    if (part === null) {
      skipped.push(leafName(box.name));
      return;
    }
    const at = placementOf(part, parsed.line, seq);
    const label = labelFor(box, parsed);

    if (box.kind === "checkbox") {
      // Grouped by the *question*, not only by where it sits. Item 18 of the
      // I-485's Part 1 carries both "Is this your current mailing address?" and
      // the Apartment/Suite/Floor selector; keyed on the item alone they merged
      // into one question offering Apartment, Suite and Floor as the answer to
      // whether an address is current.
      const groupId = `${part}:${parsed.line ?? seq}:${label}`;
      // What ticking *this* box means. The tooltip says so outright; failing
      // that the box's own name usually does — `Pt1Line3_No` is the No box.
      const value =
        tooltip.selects || humanLabel(null, parsed.tail) || leafName(box.name);

      const siblings = choiceGroups.get(groupId) ?? [];
      let group = siblings.find(
        (candidate) =>
          !candidate.members.some((m) => sameAnswer(m.value, value)),
      );

      if (!group) {
        group = { part, line: parsed.line, label, members: [], at };
        siblings.push(group);
        choiceGroups.set(groupId, siblings);
      }

      group.members.push({ value, box: box.name });
      return;
    }

    fields.push({
      fieldKey: uniqueKey(fieldKeyFor(formCode, { ...parsed, part }), usedKeys),
      label,
      partLabel: headingFor(part),
      type: inferType(box.kind, label),
      orderIndex: 0,
      config: box.options.length ? { options: box.options } : {},
      mappings: [{ value: null, pdfFieldName: box.name }],
      at,
    });
  });

  for (const group of [...choiceGroups.values()].flat()) {
    // Boxes that say they select different things are a choice between those
    // things — "Select Male." / "Select Female." A pair that only says Yes and
    // No is a yes/no question, and a lone box is a tick.
    const options = group.members
      .map((m) => m.value)
      .filter((value) => value && !/^(yes|no)$/i.test(value));
    const isChoice = options.length > 1;

    // A lone tick box has no option to name: ticking it *is* the yes.
    const members =
      group.members.length === 1 && !isChoice
        ? [{ value: "Yes", box: group.members[0].box }]
        : group.members;

    fields.push({
      fieldKey: uniqueKey(
        fieldKeyFor(formCode, {
          part: group.part,
          line: group.line,
          tail: isChoice ? "choice" : (options[0] ?? "yes_no"),
        }),
        usedKeys,
      ),
      label: group.label,
      partLabel: headingFor(group.part),
      type: inferType("checkbox", group.label, options.length),
      orderIndex: 0,
      config: isChoice ? { options } : {},
      // Every box in the group, so every answer has somewhere to go.
      mappings: members.map((m) => ({ value: m.value, pdfFieldName: m.box })),
      at: group.at,
    });
  }

  // Down the form the way the paper reads: part, then item, then the order the
  // boxes came off the page for anything the item number cannot separate.
  fields.sort(
    (a, b) =>
      a.at.part - b.at.part ||
      a.at.line - b.at.line ||
      a.at.suffix.localeCompare(b.at.suffix) ||
      a.at.seq - b.at.seq,
  );

  return {
    fields: fields.map(({ at: _at, ...field }, index) => ({
      ...field,
      orderIndex: index,
    })),
    skipped,
    noTooltip,
    parts: [...new Set(fields.map((f) => f.partLabel))],
  };
};

/** `4a` → item 4, suffix "a". A part-wide box sorts to the top of its part. */
const placementOf = (
  part: number,
  line: string | null,
  seq: number,
): Placement => {
  const match = line ? /^(\d+)([a-z])?$/.exec(line) : null;
  return {
    part,
    line: match ? Number(match[1]) : 0,
    suffix: match?.[2] ?? "",
    seq,
  };
};

/**
 * Two boxes can reduce to the same key — a form that asks for the same thing
 * twice, or a continuation page. Numbering the second one keeps both, because
 * dropping either loses a box that can never then be filled.
 */
const uniqueKey = (key: string, used: Set<string>) => {
  if (!used.has(key)) {
    used.add(key);
    return key;
  }
  let n = 2;
  while (used.has(`${key}_${n}`)) n++;
  used.add(`${key}_${n}`);
  return `${key}_${n}`;
};
