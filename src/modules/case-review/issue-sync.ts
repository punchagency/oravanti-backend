import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import type { AiScanResultJob } from "../ai-scan/contract";
import { caseIssueEvents, caseIssues } from "../../db/schema/case-issues";
import { computeFingerprint } from "./fingerprint";
import { buildRuleContext, type ScenarioParams } from "./rule-context";
import { runRules } from "./rule-registry";
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
): Promise<SyncSummary> => {
  const ctx = await buildRuleContext(params, {
    conflicts: mapConflicts(result),
    photoComparisons: mapPhotoComparisons(result),
  });

  const candidates = runRules(ctx);

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

  await db.transaction(async (tx) => {
    // All existing issues for the scenario, any status — a resolved issue whose
    // key reappears unchanged must keep its resolution.
    const existing = await tx
      .select()
      .from(caseIssues)
      .where(and(eq(caseIssues.organizationId, params.organizationId), scenarioMatch));
    const existingByKey = new Map(existing.map((e) => [e.issueKey, e]));

    for (const [issueKey, { candidate, contentHash }] of byKey) {
      const ex = existingByKey.get(issueKey);

      if (!ex) {
        const [inserted] = await tx
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
        await tx.insert(caseIssueEvents).values({
          issueId: inserted.id,
          fromStatus: null,
          toStatus: "open",
          note: "detected",
        });
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
        await tx.update(caseIssues).set(common).where(eq(caseIssues.id, ex.id));
        summary.unchanged += 1;
        continue;
      }

      // Content changed: the prior resolution no longer applies.
      const reopening = TERMINAL.has(ex.status);
      await tx
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
      await tx.insert(caseIssueEvents).values({
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
      if (ex.status !== "open" && ex.status !== "under_review") continue;
      await tx
        .update(caseIssues)
        .set({ status: "superseded", supersededAt: now, updatedAt: now })
        .where(eq(caseIssues.id, ex.id));
      await tx.insert(caseIssueEvents).values({
        issueId: ex.id,
        fromStatus: ex.status,
        toStatus: "superseded",
        note: "no longer detected",
      });
      summary.superseded += 1;
    }

    const activeRows = await tx
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
