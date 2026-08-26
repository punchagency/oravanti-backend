import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  visaBulletinCutoffs,
  type NewVisaBulletinCutoff,
  type VisaBulletinCutoff,
} from "../../db/schema/visa-bulletin";
import { createModuleLogger } from "../../lib/logging/log";

const log = createModuleLogger("uscis-reference.visa-bulletin");

/**
 * Deciding whether a priority date is current, against a stored bulletin month.
 *
 * Split deliberately in two:
 *
 *   - `isPriorityDateCurrent` and `selectGoverningCutoff` are pure. They take
 *     rows and answer a question. No database, no network, no clock beyond what
 *     is passed in — so the rules can be tested exhaustively against a fixed
 *     snapshot, which is the only way this logic gets the scrutiny it needs.
 *   - `evaluateOpenMatters` (visa-bulletin.job.ts) does the I/O.
 *
 * The rules themselves are short. Getting them wrong is not.
 */

export type IsoDate = string;

/** The subset of a cut-off row the decision actually reads. */
export type CutoffRow = Pick<
  VisaBulletinCutoff,
  "category" | "chargeabilityArea" | "chart" | "status" | "cutoffDate" | "governsAosFiling"
>;

export type Currency =
  | { current: true; because: string }
  | { current: false; because: string };

/** "worldwide" is the fallback column for every country without its own. */
export const WORLDWIDE = "worldwide";

/**
 * The row that governs an AOS filing for one category and country.
 *
 * Two lookups in priority order, and the order matters: a country with its own
 * column is never served by the worldwide row, because its own column is
 * normally the more restrictive of the two. Falling back the other way would
 * report Indian and Mexican cases as current years early.
 */
export function selectGoverningCutoff(
  rows: CutoffRow[],
  category: string,
  chargeabilityArea: string,
): CutoffRow | null {
  // Only charts USCIS said to accept for AOS filings this month are eligible;
  // the other chart's cut-offs are real data that simply does not govern here.
  const governing = rows.filter((r) => r.governsAosFiling && r.category === category);

  return (
    governing.find((r) => r.chargeabilityArea === chargeabilityArea) ??
    governing.find((r) => r.chargeabilityArea === WORLDWIDE) ??
    null
  );
}

/**
 * Whether `priorityDate` is current under the given month's cut-offs.
 *
 * Returns the reason alongside the answer because this decision is written to a
 * case and read by an attorney later; "false" on its own is not actionable.
 *
 * The comparison is `priorityDate < cutoffDate`, strictly. The bulletin's
 * convention is that a cut-off date is the first date NOT yet reached — an
 * applicant whose priority date equals the cut-off is not current. Using `<=`
 * here would tell a client to file a month early, and USCIS would reject it.
 */
export function isPriorityDateCurrent(params: {
  priorityDate: IsoDate | null;
  category: string | null;
  chargeabilityArea: string | null;
  rows: CutoffRow[];
}): Currency {
  const { priorityDate, category } = params;
  const area = params.chargeabilityArea || WORLDWIDE;

  // An immediate relative is not subject to the numerical limits, so there is no
  // cut-off to compare against and no waiting: IR is current by definition.
  if (category === "ir") {
    return { current: true, because: "Immediate relative — not subject to the annual numerical limits." };
  }

  if (!category) return { current: false, because: "No preference category recorded yet." };
  if (!priorityDate) return { current: false, because: "No priority date recorded yet." };

  const cutoff = selectGoverningCutoff(params.rows, category, area);
  if (!cutoff) {
    return {
      current: false,
      because: `No governing ${category.toUpperCase()} cut-off for ${area} in this bulletin.`,
    };
  }

  if (cutoff.status === "unavailable") {
    return { current: false, because: `${category.toUpperCase()} (${area}) is unavailable this month.` };
  }

  if (cutoff.status === "current") {
    return { current: true, because: `${category.toUpperCase()} (${area}) is current for all priority dates this month.` };
  }

  if (!cutoff.cutoffDate) {
    // A `date` row with no date is malformed. Refusing to guess is the whole
    // point of keeping the status separate from the value.
    return { current: false, because: `${category.toUpperCase()} (${area}) cut-off is missing a date.` };
  }

  const current = priorityDate < cutoff.cutoffDate;
  return {
    current,
    because: current
      ? `Priority date ${priorityDate} is before the ${category.toUpperCase()} (${area}) cut-off of ${cutoff.cutoffDate}.`
      : `Priority date ${priorityDate} is not before the ${category.toUpperCase()} (${area}) cut-off of ${cutoff.cutoffDate}.`,
  };
}

// ── Storage ────────────────────────────────────────────────────────────────

/** The most recent bulletin month on record, or null before the first ingest. */
export async function latestBulletinMonth(): Promise<IsoDate | null> {
  const [row] = await db
    .select({ bulletinMonth: visaBulletinCutoffs.bulletinMonth })
    .from(visaBulletinCutoffs)
    .orderBy(desc(visaBulletinCutoffs.bulletinMonth))
    .limit(1);

  return row?.bulletinMonth ?? null;
}

export async function cutoffsForMonth(bulletinMonth: IsoDate): Promise<CutoffRow[]> {
  return db
    .select({
      category: visaBulletinCutoffs.category,
      chargeabilityArea: visaBulletinCutoffs.chargeabilityArea,
      chart: visaBulletinCutoffs.chart,
      status: visaBulletinCutoffs.status,
      cutoffDate: visaBulletinCutoffs.cutoffDate,
      governsAosFiling: visaBulletinCutoffs.governsAosFiling,
    })
    .from(visaBulletinCutoffs)
    .where(eq(visaBulletinCutoffs.bulletinMonth, bulletinMonth));
}

/**
 * Writes one month's cut-offs, replacing that month's rows.
 *
 * All-or-nothing on purpose. A half-written month would silently answer some
 * cases from the new bulletin and some from the old, and nothing about the
 * result would look wrong.
 */
export async function saveBulletinMonth(
  bulletinMonth: IsoDate,
  rows: Omit<NewVisaBulletinCutoff, "bulletinMonth">[],
): Promise<number> {
  if (rows.length === 0) {
    // Never let an empty parse wipe a good month. See the failure posture note
    // in visa-bulletin.job.ts.
    throw new Error(`Refusing to save an empty bulletin for ${bulletinMonth}`);
  }

  return db.transaction(async (tx) => {
    await tx.delete(visaBulletinCutoffs).where(eq(visaBulletinCutoffs.bulletinMonth, bulletinMonth));
    await tx.insert(visaBulletinCutoffs).values(rows.map((r) => ({ ...r, bulletinMonth })));

    log.action("uscis.visa_bulletin_saved", { bulletinMonth, rows: rows.length });
    return rows.length;
  });
}

/** Whether a month is already on record — the ingest's idempotency check. */
export async function hasBulletinMonth(bulletinMonth: IsoDate): Promise<boolean> {
  const [row] = await db
    .select({ id: visaBulletinCutoffs.id })
    .from(visaBulletinCutoffs)
    .where(and(eq(visaBulletinCutoffs.bulletinMonth, bulletinMonth)))
    .limit(1);

  return Boolean(row);
}
