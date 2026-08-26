import { db } from "../client";
import { formEditions, type NewFormEdition } from "../schema/form-editions";
import { and, eq } from "drizzle-orm";

/**
 * The USCIS form editions a family-based AOS package is built from.
 *
 * Verified against uscis.gov on 2026-08-25. **Re-verify before trusting these
 * in production** — editions change on USCIS's schedule, sometimes with no
 * grace period, and a stale row here produces a rejected filing rather than a
 * visible error. `verifiedOn` records when a human last checked, so a row that
 * has drifted can be spotted.
 *
 * Two rows carry future `acceptedFrom` dates. That is deliberate and is the
 * whole point of seeding this now: a package drafted today for filing after
 * those dates must be built on the new edition, and only a table that knows
 * about the change ahead of time can say so.
 *
 * Idempotent: keyed on (formCode, editionDate), so re-running updates the
 * window rather than inserting a duplicate.
 */

const VERIFIED_ON = "2026-08-25";
const FORMS_UPDATES = "https://www.uscis.gov/forms/forms-updates";

const EDITIONS: NewFormEdition[] = [
  // I-485 — the 01/20/25 edition is rejected for anything postmarked on or
  // after 2026-09-18, with no grace period.
  {
    formCode: "I-485",
    editionDate: "2025-01-20",
    acceptedFrom: "2025-01-20",
    acceptedUntil: "2026-09-17",
    sourceUrl:
      "https://www.uscis.gov/newsroom/alerts/uscis-to-publish-new-edition-of-form-i-485-older-editions-will-be-rejected-starting-sept-18",
  },
  {
    formCode: "I-485",
    editionDate: "2026-09-18",
    acceptedFrom: "2026-09-18",
    acceptedUntil: null,
    sourceUrl:
      "https://www.uscis.gov/newsroom/alerts/uscis-to-publish-new-edition-of-form-i-485-older-editions-will-be-rejected-starting-sept-18",
  },

  // I-765 — same pattern, three days earlier.
  {
    formCode: "I-765",
    editionDate: "2025-08-21",
    acceptedFrom: "2025-08-21",
    acceptedUntil: "2026-09-14",
    sourceUrl: "https://www.uscis.gov/i-765",
  },
  {
    formCode: "I-765",
    editionDate: "2026-09-15",
    acceptedFrom: "2026-09-15",
    acceptedUntil: null,
    sourceUrl: "https://www.uscis.gov/i-765",
  },

  // No announced successor as of the verification date.
  { formCode: "I-130", editionDate: "2024-04-01", acceptedFrom: "2024-04-01", acceptedUntil: null, sourceUrl: "https://www.uscis.gov/i-130" },
  { formCode: "I-130A", editionDate: "2024-04-01", acceptedFrom: "2024-04-01", acceptedUntil: null, sourceUrl: "https://www.uscis.gov/i-130" },
  { formCode: "I-131", editionDate: "2024-06-17", acceptedFrom: "2024-06-17", acceptedUntil: null, sourceUrl: "https://www.uscis.gov/i-131" },

  { formCode: "I-864", editionDate: "2024-10-17", acceptedFrom: "2024-10-17", acceptedUntil: null, sourceUrl: "https://www.uscis.gov/i-864" },

  // I-693 is the one form whose edition window is keyed to the civil surgeon's
  // SIGNATURE date rather than the filing date - USCIS accepts only the
  // 01/20/25 edition for exams signed on or after 2025-07-03. Callers checking
  // I-693 must pass the signature date, not the filing date.
  { formCode: "I-693", editionDate: "2025-01-20", acceptedFrom: "2025-07-03", acceptedUntil: null, sourceUrl: "https://www.uscis.gov/i-693" },
];

export async function seedFormEditions(): Promise<void> {
  for (const edition of EDITIONS) {
    const row = { ...edition, verifiedOn: VERIFIED_ON, sourceUrl: edition.sourceUrl ?? FORMS_UPDATES };

    const [existing] = await db
      .select({ id: formEditions.id })
      .from(formEditions)
      .where(and(eq(formEditions.formCode, row.formCode), eq(formEditions.editionDate, row.editionDate)))
      .limit(1);

    if (existing) {
      await db
        .update(formEditions)
        .set({ ...row, updatedAt: new Date() })
        .where(eq(formEditions.id, existing.id));
    } else {
      await db.insert(formEditions).values(row);
    }
  }

  console.log(`  form_editions — ${EDITIONS.length} rows (verified ${VERIFIED_ON})`);
}
