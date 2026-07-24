/**
 * Read-time prose rendering.
 *
 * Issues store only facts (templateKey + templateParams); the human sentences
 * are built here, on read, in the firm's language. Keeping prose out of the
 * stored row is what lets the analysis cache stay content-addressed and the
 * fingerprint stay drift-free.
 *
 * Sentence templates are currently English; the framework is locale-keyed so a
 * language pack can be added without touching callers. Dates and numbers are
 * already formatted per the firm's locale via Intl, even within English text.
 */

export type RenderedIssue = {
  title: string;
  description: string;
  howToResolve: string | null;
};

type Params = Record<string, unknown>;
type Template = (p: Params, fmt: Formatter) => RenderedIssue;

type Formatter = {
  date: (iso: unknown) => string;
  /** e.g. "A, B and C" */
  list: (items: unknown) => string;
};

const makeFormatter = (locale: string): Formatter => ({
  date: (iso) => {
    if (typeof iso !== "string") return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(d);
  },
  list: (items) => {
    const arr = Array.isArray(items) ? items.map(String) : [];
    if (arr.length === 0) return "";
    if (arr.length === 1) return arr[0];
    return `${arr.slice(0, -1).join(", ")} and ${arr[arr.length - 1]}`;
  },
});

const str = (v: unknown, fallback = ""): string =>
  v === null || v === undefined ? fallback : String(v);

const conflictValues = (values: unknown): string => {
  if (!values || typeof values !== "object") return "";
  return Object.entries(values as Record<string, unknown>)
    .map(([k, v]) => `${k}: "${String(v)}"`)
    .join(", ");
};

const EN: Record<string, Template> = {
  missing_required_document: (p, fmt) => {
    const label = str(p.label, "A required document");
    const due =
      typeof p.daysUntil === "number"
        ? p.daysUntil < 0
          ? `It was due ${fmt.date(p.dueDate)} and is overdue.`
          : `It is due ${fmt.date(p.dueDate)} (in ${p.daysUntil} day${p.daysUntil === 1 ? "" : "s"}).`
        : "No due date is set.";
    return {
      title: `${label} missing`,
      description: `${label} has not been uploaded for this matter. ${due}`,
      howToResolve: `Request the document from the client, or waive the requirement if it does not apply.`,
    };
  },
  document_expiry_before_deadline: (p, fmt) => ({
    title: `${str(p.documentTitle, "Document")} expires before the interview`,
    description: `${str(p.documentTitle, "The document")} expires ${fmt.date(
      p.expiryDate,
    )}, within six months of the scheduled interview on ${fmt.date(
      p.interviewDate,
    )}. Validity is expected to extend beyond the adjudication period.`,
    howToResolve: `Request a renewal before the interview, or request an interview postponement.`,
  }),
  deadline_approaching_incomplete: (p, fmt) => ({
    title: `Filing package incomplete before deadline`,
    description: `${str(p.missingCount, "Some")} required document(s) are still outstanding with the filing deadline on ${fmt.date(
      p.deadline,
    )}: ${fmt.list(p.missingLabels)}.`,
    howToResolve: `Collect the outstanding documents, or request a postponement if the deadline cannot be met.`,
  }),
  filing_not_marked_submitted: (p, fmt) => ({
    title: `Filing not marked submitted`,
    description: `The filing deadline is ${fmt.date(
      p.deadline,
    )} and this matter's filing has not been marked submitted in the system.`,
    howToResolve: `Confirm whether the filing was made and mark it submitted, or complete the filing.`,
  }),
  field_conflict_across_documents: (p) => ({
    title: `Conflicting ${str(p.field, "field")} across documents`,
    description: `Documents disagree on ${str(p.field, "a field")} — ${conflictValues(
      p.values,
    )}.${p.explanation ? ` ${str(p.explanation)}` : ""}`,
    howToResolve: `Review the documents and confirm the correct value; request a corrected document if needed.`,
  }),
  field_conflict_with_scenario_record: (p) => ({
    title: `${str(p.field, "Field")} conflicts with the matter record`,
    description: `A document disagrees with the matter's own record on ${str(
      p.field,
      "a field",
    )} — ${conflictValues(p.values)}.${p.explanation ? ` ${str(p.explanation)}` : ""}`,
    howToResolve: `Verify which value is correct and update the record or request a corrected document.`,
  }),
  photo_mismatch: () => ({
    title: `Possible photo mismatch`,
    description: `The photographs on two identity documents may show different people. This is an advisory signal and requires human review.`,
    howToResolve: `Compare the photographs and the identity details; escalate to an attorney if a genuine mismatch is confirmed.`,
  }),
  document_authenticity_suspect: (p) => ({
    title: `Document authenticity flagged`,
    description: `${str(
      p.documentTitle,
      "A document",
    )} shows signs that warrant an authenticity check. This is advisory and requires human review.`,
    howToResolve: `Inspect the document; request an original or a certified copy if authenticity cannot be confirmed.`,
  }),
};

const PACKS: Record<string, Record<string, Template>> = { en: EN };

const fallback = (templateKey: string): RenderedIssue => ({
  title: templateKey.replace(/_/g, " "),
  description: "",
  howToResolve: null,
});

/** Render an issue's prose in the firm's language (falling back to English). */
export const renderIssue = (
  templateKey: string,
  templateParams: Params,
  language: string,
): RenderedIssue => {
  const locale = language || "en";
  const pack = PACKS[locale.split("-")[0]] ?? EN;
  const template = pack[templateKey] ?? EN[templateKey];
  if (!template) return fallback(templateKey);
  return template(templateParams, makeFormatter(locale));
};

/** Dashboard badge for a severity: {critical, high} → Critical, else Warning. */
export const severityBadge = (severity: string): "critical" | "warning" =>
  severity === "critical" || severity === "high" ? "critical" : "warning";

/**
 * The uppercase kicker shown above an issue's title on the dashboard card
 * ("MISSING DOCUMENT", "DEADLINE RISK", …).
 *
 * Lives here rather than in the UI for the same reason the prose does: the
 * backend owns presentation, so a new rule ships its label with it instead of
 * waiting on a matching frontend release.
 */
const CATEGORIES: Record<string, string> = {
  missing_required_document: "MISSING DOCUMENT",
  document_expiry_before_deadline: "DOCUMENT RISK",
  document_authenticity_suspect: "DOCUMENT RISK",
  deadline_approaching_incomplete: "DEADLINE RISK",
  filing_not_marked_submitted: "FILING RISK",
  field_conflict_across_documents: "DATA CONFLICT",
  field_conflict_with_scenario_record: "DATA CONFLICT",
  photo_mismatch: "IDENTITY RISK",
};

export const issueCategory = (issueType: string): string =>
  CATEGORIES[issueType] ?? issueType.replace(/_/g, " ").toUpperCase();
