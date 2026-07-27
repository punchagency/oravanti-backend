import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { withTransaction } from "../../db/transaction-context";
import type { AiScanResultJob } from "../ai-scan/contract";
import {
  caseIssueDocuments,
  caseIssueEvents,
  caseIssues,
} from "../../db/schema/case-issues";
import { documents } from "../../db/schema/documents";
import { computeFingerprint } from "./fingerprint";
import { buildRuleContext, type ScenarioParams } from "./rule-context";
import { ALL_RULES, runRules } from "./rule-registry";
import { SCAN_DEPENDENT_ISSUE_TYPES } from "./rules";
import type { CandidateIssue, Conflict, PhotoComparison } from "./types";

export type SyncSummary = {
  created: number;
  reopened: number;
  updated: number;
  unchanged: number;
  superseded: number;
  /** Issues left in an active (open / under_review) state after the sync. */
  active: number;
};

const ACTIVE = ["open", "under_review"] as const;
const TERMINAL = new Set(["resolved", "dismissed", "superseded"]);

const mapConflicts = (result: AiScanResultJob): Conflict[] =>
  result.conflicts.map((c) => ({
    field: c.field,
    participants: c.participants,
    values: c.values,
    verdict: c.verdict,
    explanation: c.explanation,
  }));

const mapPhotoComparisons = (result: AiScanResultJob): PhotoComparison[] =>
  result.photo_comparisons.map((p) => ({
    documentA: p.document_a,
    documentB: p.document_b,
    verdict: p.verdict,
    confidence: p.confidence,
  }));

/**
 * Reconcile a scenario's issues with the current rule output.
 *
 * The two-tier fingerprint drives the diff against one row per issueKey
 * (enforced by the unique index):
 *   - key absent in DB           → NEW (open)
 *   - key present, same content   → UNCHANGED (refresh severity/params; keep
 *                                    status — this is what preserves a resolution
 *                                    across reruns, incl. a due-date escalation)
 *   - key present, diff content   → CHANGED (new content; reopen if terminal)
 *   - open issue absent this run  → SUPERSEDED
 *
 * Every status transition writes a case_issue_event (the resolution log).
 */
export const syncScenarioIssues = async (
  params: ScenarioParams,
  result: AiScanResultJob,
  opts: { includeScanRules?: boolean } = {},
): Promise<SyncSummary> => {
  const includeScanRules = opts.includeScanRules ?? true;

  const ctx = await buildRuleContext(params, {
    conflicts: mapConflicts(result),
    photoComparisons: mapPhotoComparisons(result),
  });

  // A deterministic sweep (no fresh scan) runs only the non-scan-dependent
  // rules and must NOT touch AI-scan issues — otherwise an AI-less pass would
  // supersede genuine conflicts/photo mismatches.
  const rules = includeScanRules
    ? ALL_RULES
    : ALL_RULES.filter((r) => !r.scanDependent);
  const candidates = runRules(ctx, rules);

  // Fingerprint each candidate; de-dupe on issueKey (first wins).
  const byKey = new Map<
    string,
    { candidate: CandidateIssue; contentHash: string }
  >();
  for (const candidate of candidates) {
    const fp = computeFingerprint({
      scenarioId: params.id,
      issueType: candidate.issueType,
      field: candidate.affectedField,
      documentIds: candidate.documentIds,
      salientValues: candidate.salientValues,
    });
    if (!byKey.has(fp.issueKey)) {
      byKey.set(fp.issueKey, { candidate, contentHash: fp.contentHash });
    }
  }

  const scenarioMatch =
    params.type === "lead"
      ? eq(caseIssues.leadId, params.id)
      : eq(caseIssues.caseId, params.id);

  const summary: SyncSummary = {
    created: 0,
    reopened: 0,
    updated: 0,
    unchanged: 0,
    superseded: 0,
    active: 0,
  };
  const now = new Date();

  await withTransaction(db, async () => {
    // All existing issues for the scenario, any status — a resolved issue whose
    // key reappears unchanged must keep its resolution.
    const existing = await db
      .select()
      .from(caseIssues)
      .where(and(eq(caseIssues.organizationId, params.organizationId), scenarioMatch));
    const existingByKey = new Map(existing.map((e) => [e.issueKey, e]));

    // Validate the documents referenced by candidates in one query — the
    // junction FKs documents.id, and a doc could vanish between scan and sync.
    const referenced = [
      ...new Set([...byKey.values()].flatMap((v) => v.candidate.documentIds)),
    ];
    const validDocs = new Set(
      referenced.length
        ? (
            await db
              .select({ id: documents.id })
              .from(documents)
              .where(inArray(documents.id, referenced))
          ).map((r) => r.id)
        : [],
    );

    for (const [issueKey, { candidate, contentHash }] of byKey) {
      const ex = existingByKey.get(issueKey);

      if (!ex) {
        const [inserted] = await db
          .insert(caseIssues)
          .values({
            organizationId: params.organizationId,
            leadId: params.type === "lead" ? params.id : null,
            caseId: params.type === "case" ? params.id : null,
            clientId: ctx.scenario.clientId,
            issueKey,
            contentHash,
            issueType: candidate.issueType,
            source: candidate.source,
            ruleVersion: candidate.ruleVersion,
            severity: candidate.severity,
            status: "open",
            affectedField: candidate.affectedField,
            facts: candidate.facts,
            templateKey: candidate.templateKey,
            templateParams: candidate.templateParams,
            detectedAt: now,
          })
          .returning({ id: caseIssues.id });
        await db.insert(caseIssueEvents).values({
          issueId: inserted.id,
          fromStatus: null,
          toStatus: "open",
          note: "detected",
        });
        // documentIds are part of the issueKey, so they're fixed for the life of
        // an issue — the junction is written once, on creation.
        const docRows = candidate.documentIds
          .filter((docId) => validDocs.has(docId))
          .map((docId) => ({ issueId: inserted.id, documentId: docId }));
        if (docRows.length) await db.insert(caseIssueDocuments).values(docRows);
        summary.created += 1;
        continue;
      }

      const common = {
        severity: candidate.severity,
        templateParams: candidate.templateParams,
        facts: candidate.facts,
        ruleVersion: candidate.ruleVersion,
        updatedAt: now,
      };

      if (ex.contentHash === contentHash) {
        // Unchanged: refresh presentation only; never touch status/resolution.
        await db.update(caseIssues).set(common).where(eq(caseIssues.id, ex.id));
        summary.unchanged += 1;
        continue;
      }

      // Content changed: the prior resolution no longer applies.
      const reopening = TERMINAL.has(ex.status);
      await db
        .update(caseIssues)
        .set({
          ...common,
          contentHash,
          ...(reopening
            ? {
                status: "open" as const,
                resolvedById: null,
                resolvedAt: null,
                dismissedById: null,
                dismissedAt: null,
                supersededAt: null,
              }
            : {}),
        })
        .where(eq(caseIssues.id, ex.id));
      await db.insert(caseIssueEvents).values({
        issueId: ex.id,
        fromStatus: ex.status,
        toStatus: reopening ? "open" : ex.status,
        note: "content changed",
      });
      reopening ? (summary.reopened += 1) : (summary.updated += 1);
    }

    // Supersede active issues the current run no longer detects.
    for (const ex of existing) {
      if (byKey.has(ex.issueKey)) continue;
      // A deterministic sweep didn't run the scan rules, so it must not
      // supersede their issues.
      if (!includeScanRules && SCAN_DEPENDENT_ISSUE_TYPES.has(ex.issueType))
        continue;
      if (ex.status !== "open" && ex.status !== "under_review") continue;
      await db
        .update(caseIssues)
        .set({ status: "superseded", supersededAt: now, updatedAt: now })
        .where(eq(caseIssues.id, ex.id));
      await db.insert(caseIssueEvents).values({
        issueId: ex.id,
        fromStatus: ex.status,
        toStatus: "superseded",
        note: "no longer detected",
      });
      summary.superseded += 1;
    }

    const activeRows = await db
      .select({ id: caseIssues.id })
      .from(caseIssues)
      .where(
        and(
          eq(caseIssues.organizationId, params.organizationId),
          scenarioMatch,
          inArray(caseIssues.status, [...ACTIVE]),
        ),
      );
    summary.active = activeRows.length;
  });

  return summary;
};
