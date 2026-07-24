import { createHash } from "node:crypto";

/**
 * Backend-owned document-type vocabulary and the model/prompt versions the AI
 * service runs (Q5b: the backend is the single source of truth for the slug
 * list and sends it in each scan request; the AI holds no copy).
 *
 * These MUST match the AI service's model/prompt. Bump AI_PROMPT_BASE_VERSION
 * whenever a prompt change alters the facts produced from the same bytes.
 */
export const AI_MODEL_VERSION = "gemini-2.5-flash";
export const AI_PROMPT_BASE_VERSION = "v1";

/** Closed vocabulary; the AI classifies into one of these or falls back to `other`. */
export const DOCUMENT_TYPE_SLUGS = [
  "passport",
  "national_id",
  "drivers_license",
  "birth_certificate",
  "marriage_certificate",
  "divorce_decree",
  "visa",
  "residence_permit",
  "work_permit",
  "social_security_card",
  "tax_document",
  "bank_statement",
  "pay_stub",
  "utility_bill",
  "employment_letter",
  "medical_record",
  "court_filing",
  "affidavit",
  "contract",
  "other",
] as const;

/**
 * The prompt version used as the `document_analyses` cache key.
 *
 * Because the slug list is a per-request input to extraction, an extraction is
 * a function of (bytes, allowed_slugs) — so the slug list must enter the cache
 * key, or one firm could read a classification computed under a different list.
 * We fold a stable hash of the sorted list into the base version; changing the
 * vocabulary then auto-invalidates the affected cache rows. The producer and the
 * result consumer must both derive the key this way from the same list.
 */
export const effectivePromptVersion = (
  slugs: readonly string[] = DOCUMENT_TYPE_SLUGS,
): string => {
  const hash = createHash("sha256")
    .update([...slugs].sort().join(","))
    .digest("hex")
    .slice(0, 12);
  return `${AI_PROMPT_BASE_VERSION}:${hash}`;
};
