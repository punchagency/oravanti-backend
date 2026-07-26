import { createHash } from "node:crypto";
import { normalizeValue } from "./normalize";

/**
 * Two-tier issue fingerprint.
 *
 *   issueKey    = hash(scenario, issue_type, field, sorted(document_ids))
 *   contentHash = hash(normalized(salient_values))
 *
 * The pair lets a rerun distinguish three states:
 *   same key + same content  → still open; preserve resolution
 *   same key + diff content  → substance changed; supersede + reopen
 *   key absent from a run     → superseded
 *
 * Deliberately excluded from BOTH hashes:
 *  - LLM prose and severity — they drift between runs and would mint phantoms.
 *  - ruleVersion — a column, not a hash input; else every rule tweak would
 *    resurrect every resolved issue.
 * Document *ids* (stable across versions), not version ids, so a re-upload of
 * identical bytes doesn't change identity; the content hash catches real changes.
 */

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type SalientValues = Record<string, string | number | null | undefined>;

export type FingerprintInput = {
  scenarioId: string;
  issueType: string;
  /** The field an issue is about (e.g. "date_of_birth"), if any. */
  field?: string | null;
  /** Documents the issue involves; order must never matter. */
  documentIds?: string[];
  /** The values whose change should reopen the issue. */
  salientValues?: SalientValues;
};

export type Fingerprint = { issueKey: string; contentHash: string };

/** Identity of an issue — stable while it's "the same problem". */
export const issueKey = (input: FingerprintInput): string =>
  sha256([
    input.scenarioId,
    input.issueType,
    input.field ?? "",
    [...(input.documentIds ?? [])].sort(),
  ]);

/** Revision of an issue — changes when its substance changes. */
export const contentHash = (salientValues: SalientValues = {}): string => {
  const canonical: Record<string, string> = {};
  for (const key of Object.keys(salientValues).sort()) {
    canonical[key] = normalizeValue(salientValues[key]);
  }
  return sha256(canonical);
};

export const computeFingerprint = (input: FingerprintInput): Fingerprint => ({
  issueKey: issueKey(input),
  contentHash: contentHash(input.salientValues ?? {}),
});
