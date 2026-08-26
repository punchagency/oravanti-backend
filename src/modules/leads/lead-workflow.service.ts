import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import {
  leadDocumentLinks,
  leads,
} from "../../db/schema";
import { tasks } from "../../db/schema/tasks";
import { triggerScenarioScan } from "../ai-scan/scan-triggers";
import { pickAssigneeForRoles } from "../workflow/assignment.service";
import { resolveIntakePipelineSteps } from "./intake-pipeline-template.service";
import { logLeadEvent } from "./lead-events.service";
import { documents, documentVersions } from "../../db/schema/documents";

/**
 * Lead-side work that is *about the lead*: stamping its pipeline and its
 * document links.
 *
 * The per-task lifecycle used to live here too — assign, complete, the whole
 * submit/approve/reject/reopen loop — duplicating the case-side copy of the same
 * state machine. Both now run through `tasks/task-transitions.service.ts`, which
 * dispatches on the task's `source`. What is left here is what genuinely needs a
 * lead: a query that joins one, or a write that only makes sense per lead.
 */

/**
 * A lead-attached task on the unified `tasks` table: `source = 'pipeline'`,
 * `leadId` set. Every query in this service adds this filter — `leadId` alone
 * doesn't disambiguate a structured pipeline task from an ad-hoc one a firm
 * added directly to a lead, and this service only owns the former.
 */
const isPipelineTask = eq(tasks.source, "pipeline");

const roleKey = (roles: string[]) => [...roles].sort().join("|");

/**
 * Resolves one assignee per *distinct role list* on the checklist, and returns a
 * lookup over the result.
 *
 * Per role list rather than per step, because the picker load-balances on open
 * task counts and none of these tasks exist yet — nine separate calls would read
 * the same counts and hand back the same person nine times regardless. Doing it
 * once makes that explicit, and it is what intake actually wants: one person
 * carrying a lead from questionnaire through signature beats three people each
 * owning a single message.
 *
 * A role list nobody matches resolves to null. The step is still created — it
 * just lands on the board unassigned for someone to claim, which is what every
 * intake step did before roles existed.
 */
async function resolveStepAssignees(
  organizationId: string,
  steps: { assignableRoles: string[] }[],
): Promise<(roles: string[]) => string | null> {
  const byRoles = new Map<string, string | null>();

  for (const step of steps) {
    const key = roleKey(step.assignableRoles);
    if (step.assignableRoles.length === 0 || byRoles.has(key)) continue;

    byRoles.set(
      key,
      await pickAssigneeForRoles({
        organizationId,
        assignableRoles: step.assignableRoles,
        // Intake is qualification and scheduling work; nothing on the checklist
        // gates on a credential. See the schema note on `assignable_roles`.
        requiredCertifications: [],
      }),
    );
  }

  return (roles) => (roles.length === 0 ? null : (byRoles.get(roleKey(roles)) ?? null));
}

export class LeadWorkflowService {
  /**
   * Stamps the firm's intake checklist onto a lead.
   *
   * The steps come from `intake_pipeline_templates` — the firm's own active
   * template if it has one, otherwise the system default — so changing the
   * checklist is a data edit rather than a deploy. If nothing has been seeded
   * the system default is created on demand, which stops a fresh database from
   * silently producing leads with no pipeline at all.
   *
   * Each step is auto-assigned to whoever the template's `assignableRoles` point
   * at, using the same picker the case workflow uses. That is a *default*, not a
   * lock: `assignTask` can hand any step to a specific person afterwards.
   */
  async initializePipelineSteps(leadId: string, organizationId: string) {
    const existing = await db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.leadId, leadId), eq(tasks.organizationId, organizationId), isPipelineTask),
      )
      .orderBy(asc(tasks.orderIndex));
    if (existing.length > 0) return existing;

    const templateSteps = await resolveIntakePipelineSteps(organizationId);
    const assigneeFor = await resolveStepAssignees(organizationId, templateSteps);
    const assignedAt = new Date();

    const steps = await db
      .insert(tasks)
      .values(
        templateSteps.map((step) => {
          const assignedToId = assigneeFor(step.assignableRoles);
          return {
            leadId,
            organizationId,
            source: "pipeline" as const,
            pipelineTemplateStepId: step.id,
            assignedToId,
            // Assigned is not started — intake tasks stay `pending` until
            // someone picks them up, whoever they landed on.
            assignedAt: assignedToId ? assignedAt : null,
            title: step.title,
            description: step.description,
            orderIndex: step.orderIndex,
            phase: step.pipelineStage,
            isRequired: step.isRequired,
          };
        }),
      )
      .returning();

    await logLeadEvent({
      organizationId,
      leadId,
      action: "lead.pipeline_initialized",
      metadata: { taskCount: steps.length },
    });

    return steps;
  }

  // ─── Document Links ─────────────────────────────────────────────────────────

  async getLinkedDocuments(leadId: string, organizationId: string) {
    return db
      .select({
        id: leadDocumentLinks.id,
        documentId: leadDocumentLinks.documentId,
        leadId: leadDocumentLinks.leadId,
        linkedByStaffId: leadDocumentLinks.linkedByStaffId,
        archivedAt: leadDocumentLinks.archivedAt,
        createdAt: leadDocumentLinks.createdAt,
        updatedAt: leadDocumentLinks.updatedAt,
        title: documents.title,
        status: documents.status,
        category: documents.category,
        originalFileName: documentVersions.originalFileName,
        mimeType: documentVersions.mimeType,
        fileSize: documentVersions.fileSize,
        versionNumber: documentVersions.versionNumber,
        // Two independent axes: malware vs. AI document review.
        virusScanStatus: documentVersions.virusScanStatus,
        aiScanStatus: documentVersions.aiScanStatus,
      })
      .from(leadDocumentLinks)
      .innerJoin(documents, eq(leadDocumentLinks.documentId, documents.id))
      .innerJoin(leads, eq(leadDocumentLinks.leadId, leads.id))
      .leftJoin(
        documentVersions,
        eq(documents.currentVersionId, documentVersions.id),
      )
      .where(
        and(
          eq(leadDocumentLinks.leadId, leadId),
          eq(leads.organizationId, organizationId),
          // Unlinked documents keep their row for audit; don't surface them.
          isNull(leadDocumentLinks.archivedAt),
        ),
      );
  }

  async linkDocument(
    documentId: string,
    leadId: string,
    linkedByStaffId?: string,
    organizationId?: string,
  ) {
    const [link] = await db
      .insert(leadDocumentLinks)
      .values({ documentId, leadId, linkedByStaffId })
      .returning();

    if (organizationId) {
      await logLeadEvent({
        organizationId,
        leadId,
        action: "lead.document_linked",
        actorId: linkedByStaffId,
        metadata: { documentId, linkId: link.id },
      });

      // A newly-linked document is now in the lead's scan set.
      triggerScenarioScan({
        organizationId,
        scenarioType: "lead",
        scenarioId: leadId,
        trigger: "upload",
        requestedByStaffId: linkedByStaffId,
      });
    }

    return link;
  }

  async unlinkDocument(linkId: string, leadId: string, organizationId: string) {
    const [existing] = await db
      .select({ id: leadDocumentLinks.id, documentId: leadDocumentLinks.documentId })
      .from(leadDocumentLinks)
      .innerJoin(leads, eq(leadDocumentLinks.leadId, leads.id))
      .where(
        and(eq(leadDocumentLinks.id, linkId), eq(leadDocumentLinks.leadId, leadId), eq(leads.organizationId, organizationId)),
      );

    await db
      .delete(leadDocumentLinks)
      .where(
        and(
          eq(leadDocumentLinks.id, linkId),
          inArray(leadDocumentLinks.leadId, db.select({ id: leads.id }).from(leads).where(and(eq(leads.id, leadId), eq(leads.organizationId, organizationId)))),
        ),
      );

    if (organizationId && existing) {
      await logLeadEvent({
        organizationId,
        leadId,
        action: "lead.document_unlinked",
        metadata: { documentId: existing.documentId, linkId },
      });
    }
  }
}
