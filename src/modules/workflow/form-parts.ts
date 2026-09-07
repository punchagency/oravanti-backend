/**
 * Hand-written part headings, for forms whose own words cannot be read.
 *
 * ─── Normally empty, and that is the point ──────────────────────────────────
 *
 * The extractor takes each part's heading from the boxes themselves: every box
 * on a USCIS blank carries a `/TU` tooltip that opens with the printed heading,
 * and the most common heading among a part's boxes is that part's heading. Both
 * the I-130 and the I-485 are covered entirely that way, which is why there is
 * nothing below.
 *
 * This file was a table of headings typed off the PDFs by hand, and keeping it
 * is worth a sentence: **it was wrong.** It keyed headings by the part number in
 * the box *name*, and on the I-485 those disagree with the printed form from
 * Part 3 onwards — the boxes named `Pt8…` are in printed Part 9. Every heading
 * from Part 3 down was attached to the wrong part, and nothing would have
 * caught it except somebody holding the paper. The form's own words do not have
 * that failure mode.
 *
 * So this stays as the escape hatch — a form with no tooltips, or a heading the
 * vote gets wrong — and an entry here overrides what the blank says. Add one
 * only against the printed form, and say why.
 */
export const FORM_PART_TITLES: Record<string, Record<number, string>> = {};

/** `Part 4` when nothing better is known. Correct, and unhelpful — see above. */
export const partTitle = (formCode: string, part: number) =>
  FORM_PART_TITLES[formCode]?.[part] ?? `Part ${part}`;
