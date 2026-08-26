import { saveBulletinMonth } from "../../modules/uscis-reference/visa-bulletin.service";
import type { NewVisaBulletinCutoff } from "../schema/visa-bulletin";

/**
 * The September 2026 Visa Bulletin, family-sponsored, both charts.
 *
 * ─── Why this is a seed and not a scraper ───────────────────────────────────
 *
 * travel.state.gov publishes the bulletin as HTML that changes shape between
 * months and blocks automated fetches. A parser written against it would be
 * unverifiable until the month it first breaks, and the failure mode is not an
 * error — it is a silently wrong cut-off, which tells a client to file early and
 * loses them a fee and a place in the queue.
 *
 * So the month is transcribed by hand and checked against two independent
 * sources, the same discipline used for `form-editions.seed.ts`. Ingest is a
 * once-a-month, ten-minute job with a human on it. `visaBulletinSweep` then runs
 * daily and does the actual work of re-evaluating every open matter.
 *
 * ─── The chart that governs ─────────────────────────────────────────────────
 *
 * USCIS announced that ALL family-sponsored adjustment filings in September 2026
 * use the **Dates for Filing** chart, so those rows carry
 * `governsAosFiling: true` and the Final Action rows do not. Both are stored:
 * the final-action chart is what governs actual visa issuance, and keeping it
 * makes the month a complete record rather than a filtered one.
 *
 * Verified 25 Aug 2026 against:
 *   - USCIS, "When to File… September 2026" (chart selection)
 *   - Department of State Visa Bulletin for September 2026 (cut-offs)
 */

const BULLETIN_MONTH = "2026-09-01";
const SOURCE_URL =
  "https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin/2026/visa-bulletin-for-september-2026.html";

/** The five columns the bulletin prints, in its own order. */
const AREAS = ["worldwide", "CN", "IN", "MX", "PH"] as const;

type Cell = string | "C" | "U";

/** category → the five cells, left to right, exactly as the table reads. */
const DATES_FOR_FILING: Record<string, [Cell, Cell, Cell, Cell, Cell]> = {
  f1: ["2020-02-01", "2020-02-01", "2020-02-01", "2008-12-01", "2015-04-22"],
  f2a: ["C", "C", "C", "C", "C"],
  f2b: ["2019-09-01", "2019-09-01", "2019-09-01", "2010-05-15", "2013-10-01"],
  f3: ["2014-11-01", "2014-11-01", "2014-11-01", "2001-07-15", "2006-08-08"],
  f4: ["2011-11-01", "2011-11-01", "2006-12-15", "2001-04-30", "2008-03-22"],
};

const FINAL_ACTION: Record<string, [Cell, Cell, Cell, Cell, Cell]> = {
  f1: ["2020-01-22", "2020-01-22", "2020-01-22", "2005-08-22", "2013-03-22"],
  f2a: ["2026-08-22", "2026-08-22", "2026-08-22", "2025-08-22", "2026-08-22"],
  f3: ["2014-10-22", "2014-10-22", "2014-10-22", "2001-04-22", "2005-06-22"],
  f2b: ["2016-11-22", "2016-11-22", "2016-11-22", "2006-08-22", "2012-03-22"],
  f4: ["2011-10-22", "2011-10-22", "2006-08-22", "2001-03-22", "2005-09-22"],
};

/** `"C"` and `"U"` are statuses, not dates — see the schema comment on why. */
const toRow = (cell: Cell): Pick<NewVisaBulletinCutoff, "status" | "cutoffDate"> => {
  if (cell === "C") return { status: "current", cutoffDate: null };
  if (cell === "U") return { status: "unavailable", cutoffDate: null };
  return { status: "date", cutoffDate: cell };
};

function chartRows(
  table: Record<string, [Cell, Cell, Cell, Cell, Cell]>,
  chart: "dates_for_filing" | "final_action",
  governsAosFiling: boolean,
): Omit<NewVisaBulletinCutoff, "bulletinMonth">[] {
  return Object.entries(table).flatMap(([category, cells]) =>
    cells.map((cell, i) => ({
      category: category as NewVisaBulletinCutoff["category"],
      chargeabilityArea: AREAS[i],
      chart,
      governsAosFiling,
      sourceUrl: SOURCE_URL,
      ...toRow(cell),
    })),
  );
}

export async function seedVisaBulletin(): Promise<void> {
  const rows = [
    ...chartRows(DATES_FOR_FILING, "dates_for_filing", true),
    ...chartRows(FINAL_ACTION, "final_action", false),
  ];

  // Replaces the month wholesale rather than upserting cell by cell, so a
  // re-run can never leave a mix of two transcriptions.
  const saved = await saveBulletinMonth(BULLETIN_MONTH, rows);
  console.log(`Seeded ${saved} Visa Bulletin cut-offs for ${BULLETIN_MONTH}`);
}
