/**
 * The message contract between the backend and the Python AI service. These
 * types mirror `oravanti_ai/core/types.py` (ScanRequest / ScanResponse) and are
 * serialized straight into BullMQ job data. Keys are snake_case to match the
 * Python side exactly.
 */

export const AI_SCHEMA_VERSION = 1;

export type AiAuthenticityVerdict = "genuine" | "suspect" | "indeterminate";

export type AiScanDocumentFacts = {
  id: string;
  checksum: string;
  document_type: string;
  extracted_fields: Record<string, string>;
  has_photo: boolean;
  authenticity: { verdict: AiAuthenticityVerdict; confidence: number };
  ocr_artifact_key: string | null;
};

export type AiScanDocument = {
  /** documents.id — how results map back to a document in this scenario. */
  id: string;
  version_id: string;
  checksum: string;
  storage_path: string;
  mime_type: string;
  /** Non-null ⇒ backend already analysed these bytes; the worker reuses them. */
  cached_facts: AiScanDocumentFacts | null;
};

/** Published to the `ai-scan` queue; consumed by the Python worker. */
export type AiScanRequestJob = {
  schema_version: number;
  /** ai_scan_jobs.id — the backend's own job identity, echoed in the result. */
  job_id: string;
  organization_id: string;
  language: string;
  /** Effective (slug-hash-folded) prompt version; the analysis cache key. */
  prompt_version: string;
  model_version: string;
  /** Backend-owned closed vocabulary; the AI classifies into these (or `other`). */
  allowed_slugs: string[];
  documents: AiScanDocument[];
  expected_values: Record<string, string>;
  options: { cross_check: boolean; photo_compare: boolean };
};

// ── Result (produced by the worker; shape the consumer will read in a later task) ──

export type AiScanConflict = {
  field: string;
  participants: string[];
  values: Record<string, string>;
  verdict: string;
  explanation: string;
};

export type AiScanPhotoComparison = {
  document_a: string;
  document_b: string;
  verdict: "match" | "mismatch" | "indeterminate";
  confidence: number;
};

export type AiScanError = {
  document_id: string | null;
  stage: string;
  message: string;
};

/** Published to the `ai-scan-results` queue by the worker. */
export type AiScanResultJob = {
  schema_version: number;
  job_id: string;
  status: "complete" | "failed";
  model_version: string;
  prompt_version: string;
  documents: AiScanDocumentFacts[];
  conflicts: AiScanConflict[];
  photo_comparisons: AiScanPhotoComparison[];
  errors: AiScanError[];
};
