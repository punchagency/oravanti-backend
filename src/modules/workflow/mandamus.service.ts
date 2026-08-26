import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { caseForms } from "../../db/schema/case-forms";
import { uscisProcessingTimeReference } from "../../db/schema/uscis-processing-time-reference";
import { NotFoundError } from "../../utils/error/app-error";

/** One filed form, and how far past its own published median it has run. */
export type FormDelay = {
  formCode: string;
  /** Where the clock started, and whether it is the form's own date. */
  pendingSince: string;
  pendingSinceIsFormDate: boolean;
  daysPending: number;
  medianDays: number | null;
  delayRatio: number | null;
};

export type MandamusCandidacy = {
  /** Every core form currently awaiting adjudication, longest-running first. */
  forms: FormDelay[];
  /**
   * The form the attorney would actually sue over: the one furthest past its
   * median, or — when no median is known for any of them — the one that has
   * been pending longest.
   */
  mostDelayed: FormDelay | null;
};

/**
 * How far past the published median a filing has run, to two decimal places.
 *
 * Null whenever the ratio is genuinely unknowable — no median on file, or a
 * nonsensical zero median — rather than a fabricated number or a division by
 * zero. "Unknown" and "not delayed" must stay distinguishable to the reader.
 */
export function delayRatio(daysPending: number, medianDays: number | null): number | null {
  if (!medianDays || medianDays <= 0) return null;
  return Number((daysPending / medianDays).toFixed(2));
}

/**
 * Statuses that mean the form is with USCIS and still unadjudicated.
 *
 * An approved or denied form has an answer, so it cannot be delayed. A form
 * still being drafted is not pending with anybody. Only what is genuinely
 * outstanding is measured.
 */
const AWAITING_ADJUDICATION = ["filed", "receipted", "rfe"] as const;

/**
 * How long each of a matter's filings has been pending, against USCIS's own
 * published median for that form and field office.
 *
 * ─── Measured per form, not per matter ──────────────────────────────────────
 *
 * A concurrent adjustment filing is four core forms, and USCIS adjudicates
 * them on four separate clocks — the I-765 routinely lands months before the
 * I-485 it rode in with. `uscis_processing_time_reference` is keyed by form
 * type precisely because a median only means something for one form.
 *
 * So there is no single form standing in for the matter here, and no rule for
 * picking one. Each outstanding core form is measured against its own median
 * from its own filing date, and `mostDelayed` names the one an attorney would
 * actually bring the action over. Choosing a form by package order instead —
 * measuring an I-130 because it files first, while the I-485 that has sat for
 * 900 days goes unmeasured — would answer a question nobody asked.
 *
 * Supporting documents are excluded: an I-864 has no adjudication of its own
 * and no processing time to be late against.
 *
 * Computed on read, never stored and never scored in the background. It is a
 * triage heuristic an attorney reads before deciding whether to open a
 * mandamus matter — presenting it as a stored "score" would make it look like
 * a decision the system had already made, and the source material is explicit
 * that this must never be an auto-filing trigger.
 */
export async function computeMandamusCandidacy(caseId: string): Promise<MandamusCandidacy> {
  const [caseRow] = await db
    .select({
      filingDate: cases.filingDate,
      createdAt: cases.createdAt,
      // `jurisdiction` is where a USCIS field office is recorded; there is no
      // dedicated field-office column. When it's blank the lookup below falls
      // back to any office's median for the form, which is a rougher figure
      // but still more useful than no ratio at all.
      fieldOffice: cases.jurisdiction,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);

  if (!caseRow) throw new NotFoundError("Case not found");

  const outstanding = await db
    .select({ formCode: caseForms.formCode, filedDate: caseForms.filedDate })
    .from(caseForms)
    .where(
      and(
        eq(caseForms.caseId, caseId),
        eq(caseForms.role, "core"),
        inArray(caseForms.status, [...AWAITING_ADJUDICATION]),
      ),
    );

  if (outstanding.length === 0) return { forms: [], mostDelayed: null };

  // Falls back to the matter's own filing date, then to when it was opened: a
  // form can be filed and receipted before anyone gets round to recording the
  // per-form date. The fallback is flagged rather than hidden, so the UI can
  // say the figure is approximate instead of presenting a guess as a fact.
  const caseFallback = caseRow.filingDate
    ? new Date(caseRow.filingDate)
    : (caseRow.createdAt ?? null);

  const today = new Date().toISOString().split("T")[0];

  const forms: FormDelay[] = [];
  for (const form of outstanding) {
    const start = form.filedDate ? new Date(form.filedDate) : caseFallback;
    if (!start) continue;

    const daysPending = Math.floor((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000));

    // Newest reference row that was already in effect — a historical candidacy
    // check stays computable against the figure current when it was made,
    // rather than being silently rewritten by a later USCIS refresh.
    const [reference] = await db
      .select({ medianDays: uscisProcessingTimeReference.medianDays })
      .from(uscisProcessingTimeReference)
      .where(
        and(
          eq(uscisProcessingTimeReference.formType, form.formCode),
          ...(caseRow.fieldOffice
            ? [eq(uscisProcessingTimeReference.fieldOffice, caseRow.fieldOffice)]
            : []),
          lte(uscisProcessingTimeReference.effectiveDate, today),
        ),
      )
      .orderBy(desc(uscisProcessingTimeReference.effectiveDate))
      .limit(1);

    const medianDays = reference?.medianDays ?? null;

    forms.push({
      formCode: form.formCode,
      pendingSince: start.toISOString().split("T")[0],
      pendingSinceIsFormDate: Boolean(form.filedDate),
      daysPending,
      medianDays,
      delayRatio: delayRatio(daysPending, medianDays),
    });
  }

  // Ranked by how overdue each form is, which is the question. Forms with no
  // median on file sort below every form that has one — an unknown ratio is
  // not evidence of delay — and fall back to raw days pending among
  // themselves so the list still has a defensible order.
  forms.sort(
    (a, b) => (b.delayRatio ?? -1) - (a.delayRatio ?? -1) || b.daysPending - a.daysPending,
  );

  return { forms, mostDelayed: forms[0] ?? null };
}
