import { inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { formEditions, type FormEdition } from "../../db/schema/form-editions";

/**
 * Which edition of each form a package must be built on.
 *
 * USCIS rejects a filing made on a superseded edition, and the transitions can
 * land with no grace period at all — so the question is never "what is current
 * today" but "what will be current on the day this is postmarked". A package
 * drafted in August for filing in late September has to be built on the
 * September edition. Every function here therefore takes the filing date; none
 * of them default to today behind the caller's back.
 *
 * The selection is a pure function over rows (`selectPackageEditions`) with a
 * thin database wrapper around it (`checkPackageEditions`), so the date-window
 * logic — the part with the edge cases — is testable without a database.
 */

/** `YYYY-MM-DD`, matching the `date` columns these compare against. */
export type IsoDate = string;

/** The row fields the selection actually reads, so tests need not build a full row. */
export type EditionWindow = Pick<FormEdition, "formCode" | "editionDate" | "acceptedFrom" | "acceptedUntil">;

export interface PackageEditionCheck {
  formCode: string;
  /**
   * Edition dates acceptable on the filing date, newest first. Empty means we
   * hold no data for this form — reported rather than silently treated as
   * "fine", because a missing row and a satisfied rule must not look alike.
   */
  requiredEditions: IsoDate[];
  /**
   * True when the acceptable set on the filing date differs from today's: the
   * package has to be assembled on an edition that is not the current one.
   */
  editionChangePending: boolean;
}

/** ISO dates compare correctly as strings, which is why these are kept as `YYYY-MM-DD`. */
const acceptedOn = (edition: EditionWindow, on: IsoDate): boolean =>
  edition.acceptedFrom <= on && (edition.acceptedUntil === null || edition.acceptedUntil >= on);

/** Newest first, so the edition a firm should print is always `[0]`. */
const byEditionDateDesc = (a: EditionWindow, b: EditionWindow) =>
  b.editionDate.localeCompare(a.editionDate);

export function selectPackageEditions(params: {
  rows: EditionWindow[];
  formCodes: readonly string[];
  filingDate: IsoDate;
  today: IsoDate;
}): PackageEditionCheck[] {
  const { rows, formCodes, filingDate, today } = params;

  return formCodes.map((formCode) => {
    const forForm = rows.filter((r) => r.formCode === formCode);
    const atFiling = forForm.filter((r) => acceptedOn(r, filingDate)).sort(byEditionDateDesc);
    const atToday = forForm.filter((r) => acceptedOn(r, today)).sort(byEditionDateDesc);

    return {
      formCode,
      requiredEditions: atFiling.map((r) => r.editionDate),
      editionChangePending:
        atFiling.length > 0 && atToday.length > 0 && atFiling[0].editionDate !== atToday[0].editionDate,
    };
  });
}

export async function checkPackageEditions(params: {
  formCodes: readonly string[];
  filingDate: IsoDate;
  /** Overridable so the change-pending comparison is testable without freezing the clock. */
  today?: IsoDate;
}): Promise<PackageEditionCheck[]> {
  const { formCodes, filingDate } = params;
  if (formCodes.length === 0) return [];

  const rows = await db
    .select()
    .from(formEditions)
    .where(inArray(formEditions.formCode, [...formCodes]));

  return selectPackageEditions({
    rows,
    formCodes,
    filingDate,
    today: params.today ?? new Date().toISOString().split("T")[0],
  });
}

/**
 * The forms a concurrent family-based AOS package is built from.
 *
 * Note I-693: its edition window is keyed to the civil surgeon's signature
 * date, not the filing date, so check it with that date rather than folding it
 * into the package call.
 */
export const AOS_PACKAGE_FORMS = ["I-130", "I-130A", "I-485", "I-765", "I-131", "I-864"] as const;
