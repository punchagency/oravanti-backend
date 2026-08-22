import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import type { AiScanResultJob } from "../ai-scan/contract";
import { calendarEvents } from "../../db/schema/calendar-events";
import { caseIssues } from "../../db/schema/case-issues";
import { cases } from "../../db/schema/cases";
import { scenarioDocumentRequirements } from "../../db/schema/document-requirements";
import { createModuleLogger } from "../../lib/logging/log";
import { syncScenarioIssues } from "./issue-sync";
import type { ScenarioType } from "./types";

const log = createModuleLogger("case-review.deterministic-sweep");

/** Empty result — the sweep runs only rules that read persisted state. */
const EMPTY_RESULT: AiScanResultJob = {
  schema_version: 1,
  job_id: "sweep",
  status: "complete",
  model_version: "",
  prompt_version: "",
  documents: [],
  conflicts: [],
  photo_comparisons: [],
  errors: [],
};

type Scenario = { type: ScenarioType; id: string; organizationId: string };

const collectScenarios = async (): Promise<Scenario[]> => {
  const found = new Map<string, Scenario>();
  const add = (
    type: ScenarioType,
    id: string | null,
    org: string | null,
  ) => {
    if (!id || !org) return;
    found.set(`${type}:${id}`, { type, id, organizationId: org });
  };

  // Scenarios with active issues (re-evaluate to escalate/close as time passes).
  const withIssues = await db
    .selectDistinct({
      leadId: caseIssues.leadId,
      caseId: caseIssues.caseId,
      org: caseIssues.organizationId,
    })
    .from(caseIssues)
    .where(inArray(caseIssues.status, ["open", "under_review"]));
  for (const r of withIssues) {
    if (r.leadId) add("lead", r.leadId, r.org);
    else add("case", r.caseId, r.org);
  }

  // Scenarios with an unmet required document (missing-doc severity escalates).
  const withUnmet = await db
    .selectDistinct({
      leadId: scenarioDocumentRequirements.leadId,
      caseId: scenarioDocumentRequirements.caseId,
      org: scenarioDocumentRequirements.organizationId,
    })
    .from(scenarioDocumentRequirements)
    .where(
      and(
        eq(scenarioDocumentRequirements.isRequired, true),
        isNull(scenarioDocumentRequirements.satisfiedByDocumentId),
        isNull(scenarioDocumentRequirements.waivedAt),
      ),
    );
  for (const r of withUnmet) {
    if (r.leadId) add("lead", r.leadId, r.org);
    else add("case", r.caseId, r.org);
  }

  // Cases with an upcoming scheduled deadline/interview (deadline rules fire).
  const withDeadlines = await db
    .selectDistinct({ caseId: calendarEvents.caseId, org: cases.organizationId })
    .from(calendarEvents)
    .innerJoin(cases, eq(cases.id, calendarEvents.caseId))
    .where(
      and(
        eq(calendarEvents.status, "scheduled"),
        inArray(calendarEvents.eventType, ["filing_deadline", "uscis_interview"]),
      ),
    );
  for (const r of withDeadlines) add("case", r.caseId, r.org);

  return [...found.values()];
};

/**
 * Re-run the deterministic (non-scan) rules across every scenario whose
 * time-based state may have shifted, so deadline/missing-document issues appear
 * or escalate without waiting for a new document upload. AI-scan issues are left
 * untouched (includeScanRules: false).
 */
export const sweepDeterministicIssues = async (): Promise<{
  scenarios: number;
  errors: number;
}> => {
  const scenarios = await collectScenarios();
  let errors = 0;
  for (const scenario of scenarios) {
    try {
      await syncScenarioIssues(scenario, EMPTY_RESULT, { includeScanRules: false });
    } catch (err) {
      errors += 1;
      log.failure("case_review.sweep_failed", err, { scenarioType: scenario.type, scenarioId: scenario.id });
    }
  }
  return { scenarios: scenarios.length, errors };
};
