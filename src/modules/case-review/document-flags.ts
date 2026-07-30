/**
 * AI-review findings against specific documents, for surfaces outside the
 * dashboard — the intake documents checklist and the questionnaire response.
 *
 * Deliberately narrow: the flag label and severity only. `document_analyses`
 * holds raw extracted PII (passport numbers, dates of birth) and a key to the
 * full OCR text, and the views that call this are behind staff guards looser
 * than the `case_review:read` permission gating every path that reads it today.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { caseIssueDocuments, caseIssues } from "../../db/schema/case-issues";
import { documentFlagLabel, severityBadge } from "./render";

export type DocumentFlag = {
  issueId: string;
  /** Friendly label — "Expiry risk", "Conflict", "Authenticity". */
  flag: string;
  badge: "critical" | "warning";
};

const ACTIVE = ["open", "under_review"] as const;

/**
 * Open findings for each of `documentIds`, keyed by document.
 *
 * Documents with nothing against them are absent from the map — a caller must
 * distinguish "no findings" from "never scanned" using the version's
 * `aiScanStatus`, since a clean document and an unanalysed one both land here
 * with no flags.
 */
export const flagsByDocument = async (
  organizationId: string,
  documentIds: string[],
): Promise<Map<string, DocumentFlag[]>> => {
  const byDocument = new Map<string, DocumentFlag[]>();
  if (documentIds.length === 0) return byDocument;

  const rows = await db
    .select({
      documentId: caseIssueDocuments.documentId,
      issueId: caseIssues.id,
      issueType: caseIssues.issueType,
      severity: caseIssues.severity,
    })
    .from(caseIssueDocuments)
    .innerJoin(caseIssues, eq(caseIssues.id, caseIssueDocuments.issueId))
    .where(
      and(
        eq(caseIssues.organizationId, organizationId),
        inArray(caseIssues.status, [...ACTIVE]),
        inArray(caseIssueDocuments.documentId, documentIds),
      ),
    );

  for (const row of rows) {
    const flags = byDocument.get(row.documentId) ?? [];
    flags.push({
      issueId: row.issueId,
      flag: documentFlagLabel(row.issueType),
      badge: severityBadge(row.severity),
    });
    byDocument.set(row.documentId, flags);
  }
  return byDocument;
};
