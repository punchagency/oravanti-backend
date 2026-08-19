import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { documentCaseLinks } from "../../db/schema/documents";
import { leadDocumentLinks } from "../../db/schema/lead-document-links";
import { leads } from "../../db/schema/leads";
import { createModuleLogger } from "../../lib/logging/log";
import {
  enqueueScenarioScan,
  type EnqueueScenarioScanParams,
} from "./scan-producer";

const log = createModuleLogger("ai-scan.scan-triggers");

/**
 * Fire-and-forget scan trigger.
 *
 * A scan is a side effect of an upload, never a precondition — so enqueuing must
 * never break the upload it follows. We swallow-and-log failures here so callers
 * can trigger without a try/catch and without awaiting.
 */
export const triggerScenarioScan = (params: EnqueueScenarioScanParams): void => {
  void enqueueScenarioScan(params).catch((err) => {
    log.failure("ai_scan.trigger_failed", err, { scenarioType: params.scenarioType, scenarioId: params.scenarioId });
  });
};

/**
 * Trigger scans for every scenario a document belongs to, resolving each
 * scenario's organization from the link itself.
 *
 * Used when the scenario (and org) isn't known at the call site — e.g. a new
 * version of an existing document, which may be linked to a lead and/or a case.
 * Coalescing makes redundant triggers cheap.
 */
export const triggerScanForDocument = async (
  documentId: string,
  trigger: EnqueueScenarioScanParams["trigger"] = "upload",
  requestedByStaffId?: string,
): Promise<void> => {
  try {
    await resolveAndTrigger(documentId, trigger, requestedByStaffId);
  } catch (err) {
    // Fire-and-forget: resolving the document's scenarios must never break the
    // upload that triggered it.
    log.failure("ai_scan.scenario_resolve_failed", err, { documentId });
  }
};

const resolveAndTrigger = async (
  documentId: string,
  trigger: EnqueueScenarioScanParams["trigger"],
  requestedByStaffId?: string,
): Promise<void> => {
  const [leadLinks, caseLinks] = await Promise.all([
    db
      .select({
        leadId: leadDocumentLinks.leadId,
        organizationId: leads.organizationId,
      })
      .from(leadDocumentLinks)
      .innerJoin(leads, eq(leads.id, leadDocumentLinks.leadId))
      .where(
        and(
          eq(leadDocumentLinks.documentId, documentId),
          isNull(leadDocumentLinks.archivedAt),
        ),
      ),
    db
      .select({
        caseId: documentCaseLinks.caseId,
        organizationId: cases.organizationId,
      })
      .from(documentCaseLinks)
      .innerJoin(cases, eq(cases.id, documentCaseLinks.caseId))
      .where(
        and(
          eq(documentCaseLinks.documentId, documentId),
          isNull(documentCaseLinks.archivedAt),
        ),
      ),
  ]);

  for (const { leadId, organizationId } of leadLinks) {
    triggerScenarioScan({
      organizationId,
      scenarioType: "lead",
      scenarioId: leadId,
      trigger,
      requestedByStaffId,
    });
  }
  for (const { caseId, organizationId } of caseLinks) {
    triggerScenarioScan({
      organizationId,
      scenarioType: "case",
      scenarioId: caseId,
      trigger,
      requestedByStaffId,
    });
  }
};
