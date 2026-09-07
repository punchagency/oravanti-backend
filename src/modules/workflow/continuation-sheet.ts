import { PDFDocument, PDFTextField } from "@cantoo/pdf-lib";

import { leafName, parseBoxName } from "./pdf-field-naming";
import { parseIndexedKey, type RepeatGroupItemField } from "./repeat-group";

/**
 * What a repeating answer does when the blank runs out of room.
 *
 * ─── The failure this exists to stop ────────────────────────────────────────
 *
 * The I-485 prints two addresses. A client who has moved four times in five
 * years answers with four entries, and the form fills the first two — silently.
 * USCIS reads a gap in an address history as an address that was not disclosed,
 * so the third and fourth entries are not a nicety: dropping them is a defect
 * in the filing that nothing on the screen would ever mention.
 *
 * Every USCIS form answers this the same way. It ends with an "Additional
 * Information" part: numbered blocks, each holding a page number, a part
 * number, an item number and a free-text box, so an applicant can say "this
 * continues Part 1, Item 18" and write the rest out.
 *
 * ─── Nothing here is hard-coded per form ────────────────────────────────────
 *
 * The blocks are found in the PDF itself, by name and then by geometry: a box
 * whose leaf name ends `AdditionalInfo` is a block's text area, and the page /
 * part / item boxes are the nearest triple sitting above it on the same page.
 * The alternative was a table of box names per form, which is the same kind of
 * hand-written second copy that `FORMS` was, and would go stale the same way.
 *
 * Where each overflow *came from* is read the same way: the mapping for the
 * last entry the form does print names a box like `Pt1Line18_StreetNumberName`,
 * and `parseBoxName` already knows how to read the part and the item off it. So
 * the continuation block says "Part 1, Item 18" because that is genuinely where
 * the answer would have gone.
 *
 * ─── What it will not do ────────────────────────────────────────────────────
 *
 * There are four blocks on the I-485 and a similar handful elsewhere. A matter
 * with more overflow than that does not get extra pages invented for it: USCIS
 * scans these forms against a page template, and a fabricated page is a
 * rejection. The entries that do not fit are **reported**, by name, so the
 * paralegal types a plain-paper continuation sheet — which is what the
 * instructions tell an applicant to do anyway.
 */

/** One overflowing entry, ready to be written into a block. */
export type ContinuationBlock = {
  /** The page of the form the answer would have been printed on, 1-based. */
  page: string;
  /** The part it continues, e.g. `1`. */
  part: string;
  /** The item it continues, as the form prints it, e.g. `18`. */
  item: string;
  /** The entry, written out. */
  text: string;
  /** Which repeating answer and which entry — for the report, not the paper. */
  source: { base: string; index: number };
};

/** A repeating answer as the case holds it, with the labels to write it out. */
export type RepeatGroupAnswer = {
  entries: Record<string, unknown>[];
  itemLabel: string;
  fields: RepeatGroupItemField[];
};

/** The mapping rows this module needs: which datum prints into which box. */
type Mapping = { fieldKey: string; pdfFieldName: string };

/**
 * How many entries of each repeating answer the blank has room for.
 *
 * Derived from the mappings rather than declared, so an edition that adds a
 * third address block starts using it the day it is extracted — and a
 * `maxItems` in a question's config, which is a hand-written claim about a
 * piece of paper, never has to be kept in step with the paper.
 */
export function printedSlots(mappings: Mapping[]): Map<string, number> {
  const slots = new Map<string, number>();

  for (const mapping of mappings) {
    const key = parseIndexedKey(mapping.fieldKey);
    if (!key) continue;
    slots.set(key.base, Math.max(slots.get(key.base) ?? 0, key.index));
  }

  return slots;
}

/**
 * Where on the blank a repeating answer's last printed entry lives.
 *
 * Taken from the highest-indexed mapping for the group, because that is the
 * block the continuation continues. Page comes from the caller, which is the
 * only thing that has opened the PDF.
 */
function originOf(
  base: string,
  mappings: Mapping[],
  slots: Map<string, number>,
  pageOfBox: Map<string, number>,
): { part: string; item: string; page: string } | null {
  const last = slots.get(base);
  if (!last) return null;

  for (const mapping of mappings) {
    const key = parseIndexedKey(mapping.fieldKey);
    if (!key || key.base !== base || key.index !== last) continue;

    const parsed = parseBoxName(mapping.pdfFieldName);
    if (!parsed?.part || !parsed.line) continue;

    const page = pageOfBox.get(mapping.pdfFieldName);
    return {
      part: String(parsed.part),
      item: parsed.line,
      // A page the PDF could not place is left blank rather than guessed:
      // the part and item alone are enough for USCIS to find the answer.
      page: page === undefined ? "" : String(page + 1),
    };
  }

  return null;
}

/**
 * One entry, written out as the text a continuation block holds.
 *
 * Labelled lines rather than a sentence. A sentence would need a template per
 * group — "lived at X from Y to Z" — which is a claim about meaning somebody
 * has to write and maintain per form; labelled lines carry exactly what the
 * client answered, in the words the questionnaire used to ask for it.
 */
function writeEntry(
  group: RepeatGroupAnswer,
  index: number,
  entry: Record<string, unknown>,
): string {
  const lines = group.fields
    .map((field) => ({ label: field.label, value: entry[field.key] }))
    .filter(
      ({ value }) => value !== undefined && value !== null && value !== "",
    )
    .map(({ label, value }) => `${label}: ${String(value)}`);

  return [`${group.itemLabel} ${index} (continued)`, ...lines].join("\n");
}

/**
 * Every entry the blank had no room for, in the order they should be written.
 *
 * Groups the caller does not hand over are simply absent — this is the overflow
 * of what was printed, so a repeating answer the form never prints at all is
 * not this function's business.
 */
export function continuationBlocks(input: {
  mappings: Mapping[];
  groups: Map<string, RepeatGroupAnswer>;
  pageOfBox: Map<string, number>;
}): ContinuationBlock[] {
  const slots = printedSlots(input.mappings);
  const blocks: ContinuationBlock[] = [];

  for (const [base, printed] of slots) {
    const group = input.groups.get(base);
    if (!group || group.entries.length <= printed) continue;

    const origin = originOf(base, input.mappings, slots, input.pageOfBox);
    if (!origin) continue;

    for (let index = printed + 1; index <= group.entries.length; index++) {
      const entry = group.entries[index - 1];
      if (!entry) continue;

      blocks.push({
        ...origin,
        text: writeEntry(group, index, entry),
        source: { base, index },
      });
    }
  }

  return blocks;
}

/** One Additional Information block, as the blank lays it out. */
type Slot = {
  info: string;
  page: string | null;
  part: string | null;
  item: string | null;
};

const IS_INFO = /AdditionalInfo$/i;
const IS_PAGE = /PageNumber$/i;
const IS_PART = /PartNumber$/i;
const IS_ITEM = /ItemNumber$/i;

/**
 * The blank's Additional Information blocks, found by reading the PDF.
 *
 * A text box named `…AdditionalInfo` is a block. Its three label boxes are the
 * nearest Page / Part / Item boxes *above* it on the same page — "nearest
 * above" because that is how the blocks are laid out and, unlike the widget
 * order or the name index, it cannot disagree with what a person sees. On the
 * I-485 the name index happens to disagree already: `Pt9Line3c_ItemNumber[0]`
 * sits in Part 14's first block, and reading the indexes would have paired
 * every item number with the block above its own.
 *
 * Blocks come back top to bottom, page by page, which is the order they should
 * be filled in.
 */
export function findSlots(doc: PDFDocument): Slot[] {
  const pageIndex = new Map(
    doc.getPages().map((page, index) => [page.ref.tag, index]),
  );

  type Box = { name: string; page: number; y: number };
  const infos: Box[] = [];
  const labels: { kind: "page" | "part" | "item"; box: Box }[] = [];

  for (const field of doc.getForm().getFields()) {
    const name = field.getName();
    const leaf = leafName(name);

    const kind = IS_PAGE.test(leaf)
      ? ("page" as const)
      : IS_PART.test(leaf)
        ? ("part" as const)
        : IS_ITEM.test(leaf)
          ? ("item" as const)
          : null;

    if (!kind && !IS_INFO.test(leaf)) continue;

    for (const widget of field.acroField.getWidgets()) {
      const parent = widget.P();
      const page = parent ? pageIndex.get(parent.tag) : undefined;
      if (page === undefined) continue;

      const box: Box = { name, page, y: widget.getRectangle().y };
      if (kind) labels.push({ kind, box });
      else infos.push(box);
    }
  }

  const nearestAbove = (info: Box, kind: "page" | "part" | "item") => {
    let best: { box: Box; gap: number } | null = null;

    for (const label of labels) {
      if (label.kind !== kind) continue;
      if (label.box.page !== info.page) continue;

      const gap = label.box.y - info.y;
      if (gap <= 0) continue;
      if (!best || gap < best.gap) best = { box: label.box, gap };
    }

    return best?.box ?? null;
  };

  return infos
    .sort((a, b) => a.page - b.page || b.y - a.y)
    .map((info) => ({
      info: info.name,
      page: nearestAbove(info, "page")?.name ?? null,
      part: nearestAbove(info, "part")?.name ?? null,
      item: nearestAbove(info, "item")?.name ?? null,
    }));
}

/**
 * Write the blocks onto the blank's continuation sheet.
 *
 * `unplaced` is the point of the return value: four blocks is not many, and a
 * matter that overflows them needs a paralegal to type a plain sheet. Saying
 * which entries did not fit is the difference between that and a filing with
 * two addresses missing and nothing anywhere saying so.
 */
export function fillContinuation(
  doc: PDFDocument,
  blocks: ContinuationBlock[],
): { written: number; unplaced: ContinuationBlock[] } {
  if (blocks.length === 0) return { written: 0, unplaced: [] };

  const form = doc.getForm();
  const slots = findSlots(doc);
  let written = 0;

  const write = (name: string | null, value: string) => {
    if (!name || value === "") return;
    try {
      const field = form.getField(name);
      if (field instanceof PDFTextField) field.setText(value);
    } catch {
      // A box the blank turns out not to have is not an error — it is a form
      // laid out slightly differently, and the block is still worth writing
      // for the boxes it does have.
    }
  };

  const placed = Math.min(blocks.length, slots.length);

  for (let i = 0; i < placed; i++) {
    const slot = slots[i];
    const block = blocks[i];

    write(slot.page, block.page);
    write(slot.part, block.part);
    write(slot.item, block.item);
    write(slot.info, block.text);
    written += 1;
  }

  return { written, unplaced: blocks.slice(placed) };
}
