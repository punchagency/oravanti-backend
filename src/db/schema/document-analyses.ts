import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const documentAnalysisStatusEnum = pgEnum("document_analysis_status", [
  "complete",
  "failed",
  "skipped",
]);

export const authenticityVerdictEnum = pgEnum("authenticity_verdict", [
  "genuine",
  "suspect",
  "indeterminate",
]);

export const photoComparisonVerdictEnum = pgEnum("photo_comparison_verdict", [
  "match",
  "mismatch",
  "indeterminate",
]);

/**
 * Extraction cache and facts store.
 *
 * CONTENT-ADDRESSED ON PURPOSE — keyed by `(checksum, promptVersion,
 * modelVersion)` with NO organization column. Because documents are
 * transferable between firms and the AI's output is language-neutral, an
 * extraction is a pure function of the bytes: two firms holding the same
 * document analyze it once.
 *
 * This is not a cross-tenant leak. A checksum can only be produced by
 * possessing the bytes, and facts derived from bytes you already hold reveal
 * nothing you could not compute yourself. It only works because the AI emits
 * language-neutral slugs and values — firm-language prose would force a
 * per-firm cache and double the cost on shared documents.
 *
 * Deliberately NOT keyed on `documentVersionId`: many version rows (across
 * firms, or from independent uploads of identical bytes) share one checksum.
 */
export const documentAnalyses = pgTable(
  "document_analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checksum: text("checksum").notNull(),
    promptVersion: text("prompt_version").notNull(),
    modelVersion: text("model_version").notNull(),

    status: documentAnalysisStatusEnum("status").notNull(),
    /** Closed-vocabulary slug; `other` when the AI can't classify it. */
    documentTypeSlug: text("document_type_slug"),
    extractedFields: jsonb("extracted_fields").notNull().default({}),
    /** Gates the photo-comparison step — it only runs with >= 2 photo docs. */
    hasPhoto: boolean("has_photo").notNull().default(false),

    authenticityVerdict: authenticityVerdictEnum("authenticity_verdict"),
    authenticityConfidence: numeric("authenticity_confidence", {
      precision: 4,
      scale: 3,
    }),

    /** R2 key under `ai-artifacts/` holding the raw OCR text. */
    ocrArtifactKey: text("ocr_artifact_key"),
    error: text("error"),
    analyzedAt: timestamp("analyzed_at").notNull().defaultNow(),
  },
  (table) => [
    unique("document_analyses_content_key_unique").on(
      table.checksum,
      table.promptVersion,
      table.modelVersion,
    ),
    index("document_analyses_checksum_idx").on(table.checksum),
    index("document_analyses_type_slug_idx").on(table.documentTypeSlug),
  ],
);

/**
 * Pairwise photo-comparison cache, also content-addressed.
 *
 * Pairwise rather than set-wise so adding a third identity document costs two
 * new comparisons instead of redoing everything. Checksums are stored sorted
 * (enforced by CHECK) so (A,B) and (B,A) can never both exist.
 *
 * Findings from this table are severity-capped at `medium` by the rules engine:
 * LLM face matching is materially less reliable than field comparison, and on
 * an immigration matter "these photos don't match" is functionally a fraud
 * accusation.
 */
export const documentPhotoComparisons = pgTable(
  "document_photo_comparisons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checksumA: text("checksum_a").notNull(),
    checksumB: text("checksum_b").notNull(),
    modelVersion: text("model_version").notNull(),

    verdict: photoComparisonVerdictEnum("verdict").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    comparedAt: timestamp("compared_at").notNull().defaultNow(),
  },
  (table) => [
    check("dpc_checksums_sorted", sql`${table.checksumA} < ${table.checksumB}`),
    unique("document_photo_comparisons_pair_unique").on(
      table.checksumA,
      table.checksumB,
      table.modelVersion,
    ),
    index("dpc_checksum_a_idx").on(table.checksumA),
    index("dpc_checksum_b_idx").on(table.checksumB),
  ],
);

export type DocumentAnalysis = typeof documentAnalyses.$inferSelect;
export type NewDocumentAnalysis = typeof documentAnalyses.$inferInsert;
export type DocumentPhotoComparison =
  typeof documentPhotoComparisons.$inferSelect;
export type NewDocumentPhotoComparison =
  typeof documentPhotoComparisons.$inferInsert;
