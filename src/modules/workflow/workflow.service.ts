import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { auditEvents } from "../../db/schema/audit-events";
import { cases } from "../../db/schema/cases";
import { staff } from "../../db/schema/staff";
import { createModuleLogger } from "../../lib/logging/log";
import { assertAssignableStaff } from "../../utils/assignable-staff";
import { tasks } from "../../db/schema/tasks";
import {
  caseNotes,
  workflowModules,
  workflowTemplateSteps,
  type Condition,
} from "../../db/schema/workflow";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { recordTaskReviewEvent } from "../shared/task-review-events.service";
import { logCaseEvent } from "../cases/case-events.service";
import { recordAuditEvent } from "../shared/audit.service";
import { labelFor } from "../../lib/audit/actions";
import type { AuditActionName } from "../../lib/audit/actions";
import { getCaseTeamId, pickBestAssignee } from "./assignment.service";
import { materializeModule, materializeTasksForCase } from "./task-materialization.service";

const log = createModuleLogger("workflow.service");

/**
 * A case-attached task materialized from a workflow template:
 * `source = 'workflow'`. Every query below adds this filter — a case's
 * `tasks` rows can also be `ad_hoc` (see `tasks.service.ts`), and this
 * service only owns the workflow-sourced ones.
 */
const isWorkflowTask = eq(tasks.source, "workflow");

/** Statuses a step can be brought back from. Mirrors `TRANSITIONS.reopen`. */
const REOPENABLE_STATUSES = new Set(["rejected", "completed", "skipped"]);

// ─── Metadata helpers ──────────────────────────────────────────────────────────

async function resolveModuleName(
  templateStepId: string | null | undefined,
): Promise<string | null> {
  if (!templateStepId) return null;
  const [ts] = await db
    .select({ moduleId: workflowTemplateSteps.moduleId })
    .from(workflowTemplateSteps)
    .where(eq(workflowTemplateSteps.id, templateStepId))
    .limit(1);
  if (!ts) return null;
  const [mod] = await db
    .select({ name: workflowModules.name })
    .from(workflowModules)
    .where(eq(workflowModules.id, ts.moduleId))
    .limit(1);
  return mod?.name ?? null;
}

async function resolveStaffNames(
  ...ids: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: staff.id, firstName: staff.firstName, lastName: staff.lastName })
    .from(staff)
    .where(inArray(staff.id, unique));
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id, `${r.firstName} ${r.lastName}`.trim());
  return map;
}

export class WorkflowService {
  // ─── Get workflow for a case (read-only) ────────────────────────────────────────

  async getWorkflow(caseId: string, organizationId: string) {
    await this.getCase(caseId, organizationId);

    const existingSteps = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.caseId, caseId), eq(tasks.organizationId, organizationId), isWorkflowTask))
      .limit(1);

    // No-ops when the case has no team yet — its steps would have nobody to be
    // assigned from. The case detail already carries `assignedTeam`, so the
    // workflow tab says so without needing a flag on this response.
    if (existingSteps.length === 0) {
      await materializeTasksForCase(caseId);
    }

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Hydrate: copy template → case instances ────────────────────────────────────

  // ─── Get workflow response ──────────────────────────────────────────────────────

  private async buildWorkflowResponse(caseId: string, organizationId: string) {
    const modules = await db
      .select()
      .from(workflowModules)
      .innerJoin(
        workflowTemplateSteps,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .innerJoin(
        tasks,
        eq(tasks.workflowTemplateStepId, workflowTemplateSteps.id),
      )
      .where(
        and(
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      )
      .orderBy(
        asc(workflowModules.orderIndex),
        asc(workflowTemplateSteps.orderIndex),
      );

    if (modules.length === 0) {
      return { caseId, modules: [], startedAt: null };
    }

    const stepStaffIds = new Set<string>();
    for (const row of modules) {
      if (row.tasks.assignedToId)
        stepStaffIds.add(row.tasks.assignedToId);
      if (row.tasks.completedById)
        stepStaffIds.add(row.tasks.completedById);
    }

    const staffMap = new Map<
      string,
      { id: string; name: string; role: string }
    >();
    if (stepStaffIds.size > 0) {
      const staffRows = await db
        .select()
        .from(staff)
        .where(inArray(staff.id, [...stepStaffIds]));
      for (const s of staffRows) {
        staffMap.set(s.id, {
          id: s.id,
          name: `${s.firstName} ${s.lastName}`,
          role: s.jobTitle ?? "",
        });
      }
    }

    const moduleMap = new Map<
      string,
      {
        moduleId: string;
        name: string;
        phase: string;
        orderIndex: number;
        activationType: string;
        activationCondition: Condition | null;
        status: "locked" | "active" | "completed";
        steps: {
          stepId: string;
          title: string;
          status: string;
          assignedTo: { id: string; name: string; role: string } | null;
          dueDate: string | null;
          completedAt: string | null;
          notes: string;
        }[];
      }
    >();

    for (const row of modules) {
      const mod = row.workflow_modules;
      const cs = row.tasks;
      const stepId = cs.id;

      if (!moduleMap.has(mod.id)) {
        moduleMap.set(mod.id, {
          moduleId: mod.id,
          name: mod.name,
          phase: mod.phase,
          orderIndex: mod.orderIndex,
          activationType: mod.activationType,
          activationCondition: mod.activationCondition,
          status: "locked",
          steps: [],
        });
      }

      const entry = moduleMap.get(mod.id)!;
      entry.steps.push({
        stepId,
        title: cs.title,
        status: cs.status,
        assignedTo: cs.assignedToId
          ? (staffMap.get(cs.assignedToId) ?? null)
          : null,
        dueDate: cs.dueDate,
        completedAt: cs.completedAt?.toISOString() ?? null,
        notes: cs.notes ?? "",
      });
    }

    const sortedModules = [...moduleMap.values()].sort(
      (a, b) => a.orderIndex - b.orderIndex,
    );

    // Compute module status from step statuses
    const modulesWithStatus = sortedModules.map((mod) => {
      const stepStatuses = mod.steps.map((s) => s.status);
      const allCompleted = stepStatuses.every((s) => s === "completed");
      // `rejected` counts as under way: the work has been started and sent
      // back, so a module holding one must not fall through to "locked".
      const anyInProgress = stepStatuses.some(
        (s) => s === "in_progress" || s === "in_review" || s === "rejected",
      );
      const anyStarted = stepStatuses.some(
        (s) =>
          s === "in_progress" ||
          s === "in_review" ||
          s === "rejected" ||
          s === "completed",
      );

      let status: "locked" | "active" | "completed";
      if (allCompleted) {
        status = "completed";
      } else if (anyInProgress) {
        status = "active";
      } else if (anyStarted) {
        status = "active";
      } else {
        // Check if previous module is completed
        const modIndex = sortedModules.indexOf(mod);
        if (modIndex === 0) {
          status = "active";
        } else {
          const prevModule = sortedModules[modIndex - 1];
          const prevAllCompleted = prevModule.steps.every(
            (s) => s.status === "completed",
          );
          status = prevAllCompleted ? "active" : "locked";
        }
      }

      return { ...mod, status };
    });

    const startedSteps = modules.filter(
      (r) => r.tasks.status !== "pending",
    );
    const startedAt =
      startedSteps.length > 0
        ? startedSteps[0].tasks.createdAt.toISOString()
        : null;

    return {
      caseId,
      modules: modulesWithStatus,
      startedAt,
    };
  }

  // ─── Get workflow summary ───────────────────────────────────────────────────────

  async getWorkflowSummary(caseId: string, organizationId: string) {
    const steps = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      );

    // Withdrawn steps leave the denominator. A step whose condition stopped
    // holding is not outstanding work, and counting it would hold the matter
    // permanently short of 100% for work nobody is ever going to do.
    const applicableSteps = steps.filter((s) => s.status !== "cancelled");

    const totalSteps = applicableSteps.length;
    const completedSteps = applicableSteps.filter((s) => s.status === "completed").length;
    const percentage =
      totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

    // A rejected step is still where the case's attention is, so it can name
    // the current module — but a genuinely in-progress step takes precedence.
    const inProgressStep =
      steps.find((s) => s.status === "in_progress") ??
      steps.find((s) => s.status === "rejected");
    let currentModuleName: string | null = null;
    let currentModuleId: string | null = null;

    if (inProgressStep?.workflowTemplateStepId) {
      const [templateStep] = await db
        .select()
        .from(workflowTemplateSteps)
        .where(eq(workflowTemplateSteps.id, inProgressStep.workflowTemplateStepId))
        .limit(1);
      if (templateStep) {
        const [mod] = await db
          .select()
          .from(workflowModules)
          .where(eq(workflowModules.id, templateStep.moduleId))
          .limit(1);
        if (mod) {
          currentModuleName = mod.name;
          currentModuleId = mod.id;
        }
      }
    }

    return {
      templateName: "Workflow",
      totalSteps,
      completedSteps,
      percentage,
      currentModuleName,
      currentModuleId,
    };
  }

  // ─── Start a step ───────────────────────────────────────────────────────────────

  /**
   * The assignee saying they have picked the step up.
   *
   * Kept in step with `TRANSITIONS.start` in tasks/task-transitions.service.ts,
   * which is the one place the lifecycle is defined — this method is what that
   * dispatches to for a case step.
   *
   * Materialization used to stamp `in_progress` the moment a step was
   * auto-assigned, so every step on a freshly opened matter claimed to be
   * underway and the status carried no information. Assignment now leaves the
   * step `pending` and this is the only way it advances, which is what makes
   * "in progress" mean a person is actually working on it.
   *
   * `case.step_started` was already in the audit registry and already mapped in
   * `logStepAction`; nothing had ever been able to emit it.
   */
  async startStep(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    notes?: string,
  ) {
    const [step] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, stepId),
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");

    if (step.status !== "pending") {
      log.warn("workflow.start_rejected", { stepId, status: step.status });
      throw new BadRequestError("Only a step that has not been started yet can be started");
    }

    await db
      .update(tasks)
      .set({ status: "in_progress", updatedAt: new Date() })
      .where(and(eq(tasks.id, stepId), eq(tasks.organizationId, organizationId)));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "STARTED",
      title: `Step started: ${step.title}`,
      actorId: performedById,
      note: notes?.trim() || null,
    });

    return this.getWorkflowSummary(caseId, organizationId);
  }

  // ─── Complete a step ────────────────────────────────────────────────────────────

  private async createStepNote(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById: string,
    content: string,
  ) {
    return this.createNote({
      caseId,
      organizationId,
      taskId: stepId,
      context: "workflow_step",
      content,
      createdByUserId: performedById,
    });
  }

  async completeStep(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    notes?: string,
  ) {
    const [step] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, stepId),
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status === "completed")
      return this.buildWorkflowResponse(caseId, organizationId);

    const now = new Date();
    let timeTakenMs: number | null = null;
    if (step.assignedAt) {
      timeTakenMs = now.getTime() - new Date(step.assignedAt).getTime();
    }

    await db
      .update(tasks)
      .set({
        status: "completed",
        completedAt: now,
        completedById: performedById,
        timeTakenMs,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, stepId), eq(tasks.organizationId, organizationId)));

    const [moduleName, staffMap] = await Promise.all([
      resolveModuleName(step.workflowTemplateStepId),
      resolveStaffNames(performedById),
    ]);
    const completedByName = performedById ? (staffMap.get(performedById) ?? null) : null;

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "COMPLETED",
      title: `Step completed: ${step.title}`,
      actorId: performedById,
      note: notes?.trim() || null,
      timeTakenMs,
    });

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_COMPLETED",
      title: `Step completed: ${step.title}`,
      description: completedByName
        ? `${completedByName} completed "${step.title}"`
        : `Step "${step.title}" completed`,
      metadata: {
        previousStatus: step.status,
        newStatus: "completed",
        timeTakenMs,
        completedById: performedById,
        completedByName,
        moduleName,
        stepTitle: step.title,
        note: notes?.trim() || null,
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    if (notes?.trim() && performedById) {
      await this.createStepNote(caseId, stepId, organizationId, performedById, notes.trim());
    }

    // Auto-assign next pending step within same module
    await this.autoAssignNextStep(
      caseId,
      stepId,
      organizationId,
      performedById,
    );

    log.action("workflow.completed", { caseId, stepId, stepTitle: step.title });

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Assign staff to step ───────────────────────────────────────────────────────

  async assignStep(
    caseId: string,
    stepId: string,
    staffId: string,
    organizationId: string,
    overrideRationale?: string,
    performedById?: string,
  ) {
    const [step] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, stepId),
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");

    await assertAssignableStaff(staffId, organizationId);

    const [staffMember] = await db
      .select()
      .from(staff)
      .where(
        and(
          eq(staff.id, staffId),
          eq(staff.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!staffMember) throw new NotFoundError("Staff not found");

    const now = new Date();
    const updateData: Partial<typeof tasks.$inferInsert> = {
      assignedToId: staffId,
      assignedAt: now,
      status: "in_progress",
      updatedAt: now,
    };

    if (overrideRationale) {
      updateData.overrideRationale = overrideRationale;
      updateData.overrideById = performedById ?? null;
      updateData.overrideAt = now;
    }

    await db
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, stepId));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "ASSIGNED",
      title: `Step assigned: ${step.title}`,
      assigneeId: staffId,
      actorId: performedById ?? null,
      note: overrideRationale || null,
    });

    const [moduleName2, assignerMap] = await Promise.all([
      resolveModuleName(step.workflowTemplateStepId),
      resolveStaffNames(performedById),
    ]);
    const assignerName = performedById ? (assignerMap.get(performedById) ?? null) : null;

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_ASSIGNED",
      title: `Step assigned: ${step.title}`,
      description: assignerName
        ? `${assignerName} assigned "${step.title}" to ${staffMember.firstName} ${staffMember.lastName}`
        : `Assigned to ${staffMember.firstName} ${staffMember.lastName}`,
      metadata: {
        assignmentStrategy: overrideRationale ? "manual_override" : "system",
        staffId,
        staffName: `${staffMember.firstName} ${staffMember.lastName}`,
        assignerId: performedById ?? null,
        assignerName,
        moduleName: moduleName2,
        stepTitle: step.title,
        overrideRationale: overrideRationale ?? null,
        note: overrideRationale || null,
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Manually activate a module ─────────────────────────────────────────────────

  async activateModule(
    caseId: string,
    moduleId: string,
    organizationId: string,
  ) {
    /*
      Create the module's tasks if they don't exist yet.

      A `manual` module is skipped by whole-case materialization by design —
      "manual" means someone decides when the stage starts, and this is that
      decision. Without this call the lookup below found nothing and threw,
      which made every manual module (eleven of the twenty Personal Injury
      ones, the whole litigation half) impossible to open. Idempotent, so
      re-activating an already-open module is a no-op rather than a duplicate.
    */
    await materializeModule(caseId, moduleId);

    const moduleSteps = await db
      .select()
      .from(tasks)
      .innerJoin(
        workflowTemplateSteps,
        eq(tasks.workflowTemplateStepId, workflowTemplateSteps.id),
      )
      .where(
        and(
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
          eq(workflowTemplateSteps.moduleId, moduleId),
        ),
      )
      .orderBy(asc(tasks.orderIndex))
      .limit(1);

    // Now only reachable when the module genuinely has no template steps, or
    // belongs to another firm's template.
    if (moduleSteps.length === 0)
      throw new NotFoundError("No steps found for this module in the case");

    const firstStep = moduleSteps[0].tasks;
    if (firstStep.status === "pending") {
      await db
        .update(tasks)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(eq(tasks.id, firstStep.id));
    }

    const [mod] = await db
      .select()
      .from(workflowModules)
      .where(eq(workflowModules.id, moduleId))
      .limit(1);

    await logEvent({
      organizationId,
      caseId,
      moduleId,
      eventType: "MODULE_ACTIVATED",
      title: `Module activated: ${mod?.name ?? moduleId}`,
      description: `Module "${mod?.name ?? moduleId}" activated`,
      metadata: {
        moduleName: mod?.name,
        activationType: mod?.activationType,
        timestamp: new Date().toISOString(),
      },
      performedById: null,
    });

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Get timeline events ────────────────────────────────────────────────────────

  async getTimeline(caseId: string, organizationId: string) {
    // All case timeline events now live in `audit_events` — the old
    // `case_timeline_events` table has been removed.
    const rows = await db
      .select({
        id: auditEvents.id,
        eventType: auditEvents.action,
        summary: auditEvents.summary,
        metadata: auditEvents.metadata,
        actorStaffId: auditEvents.actorStaffId,
        occurredAt: auditEvents.occurredAt,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, "case"),
          eq(auditEvents.entityId, caseId),
          eq(auditEvents.organizationId, organizationId),
        ),
      )
      .orderBy(asc(auditEvents.occurredAt));

    // Resolve step titles for any stepIds found in audit event metadata
    const stepIdSet = new Set<string>();
    for (const ev of rows) {
      const sid = (ev.metadata as Record<string, unknown>)?.stepId;
      if (typeof sid === "string") stepIdSet.add(sid);
    }
    const stepTitleMap = new Map<string, string>();
    if (stepIdSet.size > 0) {
      const stepRows = await db
        .select({ id: tasks.id, title: tasks.title })
        .from(tasks)
        .where(inArray(tasks.id, [...stepIdSet]));
      for (const s of stepRows) stepTitleMap.set(s.id, s.title);
    }

    const timelineEntries = rows.map((ev) => {
      const meta = (ev.metadata ?? {}) as Record<string, unknown>;
      const stepId = meta.stepId as string | undefined;
      return {
        id: ev.id,
        eventType: ev.eventType,
        title: labelFor(ev.eventType),
        description: ev.summary,
        metadata: {
          ...meta,
          stepTitle: stepId ? stepTitleMap.get(stepId) ?? null : null,
        } as Record<string, unknown> | null,
        actorId: ev.actorStaffId,
        createdAt: ev.occurredAt,
      };
    });

    // Resolve staff names
    const allStaffIds = [
      ...new Set(
        timelineEntries
          .map((e) => e.actorId)
          .filter((id): id is string => id !== null),
      ),
    ];

    const staffMap = new Map<string, { id: string; name: string }>();
    if (allStaffIds.length > 0) {
      const staffRows = await db
        .select()
        .from(staff)
        .where(inArray(staff.id, allStaffIds));
      for (const s of staffRows) {
        staffMap.set(s.id, { id: s.id, name: `${s.firstName} ${s.lastName}` });
      }
    }

    return timelineEntries.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      title: e.title,
      description: e.description,
      metadata: e.metadata as Record<string, unknown> | null,
      createdBy: e.actorId ? (staffMap.get(e.actorId) ?? null) : null,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  // ─── Get audit log ──────────────────────────────────────────────────────────────

  async getLogs(caseId: string, organizationId: string) {
    const logs = await db
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        summary: auditEvents.summary,
        metadata: auditEvents.metadata,
        actorStaffId: auditEvents.actorStaffId,
        actorName: auditEvents.actorName,
        occurredAt: auditEvents.occurredAt,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, caseId),
          eq(auditEvents.organizationId, organizationId),
          sql`${auditEvents.action} LIKE 'case.%'`,
        ),
      )
      .orderBy(asc(auditEvents.occurredAt));

    return logs.map((l) => ({
      id: l.id,
      eventType: l.action.replace("case.", ""),
      title: l.summary,
      description: null,
      metadata: l.metadata,
      performedBy: l.actorStaffId
        ? { id: l.actorStaffId, name: l.actorName }
        : null,
      createdAt: l.occurredAt.toISOString(),
    }));
  }

  // ─── Submit step for review (active → in_review) ────────────────────────────────

  async submitForReview(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    notes?: string,
  ) {
    const [step] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, stepId),
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    // A rejected step is resubmitted straight from here rather than forcing a
    // separate reopen round trip.
    if (step.status !== "in_progress" && step.status !== "rejected") {
      log.warn("workflow.submit_rejected", { stepId, status: step.status });
      throw new BadRequestError(
        "Step must be in_progress or rejected to submit for review",
      );
    }

    const now = new Date();
    let timeTakenMs: number | null = null;
    if (step.assignedAt) {
      timeTakenMs = now.getTime() - new Date(step.assignedAt).getTime();
    }

    await db
      .update(tasks)
      .set({ status: "in_review", updatedAt: now })
      .where(and(eq(tasks.id, stepId), eq(tasks.organizationId, organizationId)));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "SUBMITTED",
      title: `Step submitted for review: ${step.title}`,
      actorId: performedById,
      note: notes?.trim() || null,
      timeTakenMs,
    });

    await recordTaskReviewEvent({
      organizationId,
      taskKind: "case_step",
      taskId: stepId,
      caseId,
      action: "task.submitted",
      note: notes,
      actorId: performedById,
    });

    const [subModName, subActorMap] = await Promise.all([
      resolveModuleName(step.workflowTemplateStepId),
      resolveStaffNames(performedById),
    ]);
    const submittedByName = performedById ? (subActorMap.get(performedById) ?? null) : null;

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_SUBMITTED_FOR_REVIEW",
      title: `Step submitted for review: ${step.title}`,
      description: submittedByName
        ? `${submittedByName} submitted "${step.title}" for review`
        : `Step "${step.title}" submitted for review`,
      metadata: {
        previousStatus: "in_progress",
        newStatus: "in_review",
        stepTitle: step.title,
        moduleName: subModName,
        submittedById: performedById ?? null,
        submittedByName,
        timeTakenMs,
        note: notes?.trim() || null,
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    if (notes?.trim() && performedById) {
      await this.createStepNote(caseId, stepId, organizationId, performedById, notes.trim());
    }

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Approve step (in_review → completed) ───────────────────────────────────────

  async approveStep(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    notes?: string,
  ) {
    const [step] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, stepId),
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status !== "in_review") {
      log.warn("workflow.approve_rejected", { stepId, status: step.status });
      throw new BadRequestError("Step must be in_review to approve");
    }

    const now = new Date();
    let timeTakenMs: number | null = null;
    if (step.assignedAt) {
      timeTakenMs = now.getTime() - new Date(step.assignedAt).getTime();
    }

    await db
      .update(tasks)
      .set({
        status: "completed",
        completedAt: now,
        completedById: performedById,
        timeTakenMs,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, stepId), eq(tasks.organizationId, organizationId)));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "APPROVED",
      title: `Step approved: ${step.title}`,
      actorId: performedById,
      assigneeId: step.assignedToId,
      note: notes?.trim() || null,
      timeTakenMs,
    });

    await recordTaskReviewEvent({
      organizationId,
      taskKind: "case_step",
      taskId: stepId,
      caseId,
      action: "task.approved",
      note: notes,
      actorId: performedById,
    });

    const [apprModName, apprActorMap] = await Promise.all([
      resolveModuleName(step.workflowTemplateStepId),
      resolveStaffNames(performedById, step.assignedToId),
    ]);
    const reviewerName = performedById ? (apprActorMap.get(performedById) ?? null) : null;
    const assigneeName = step.assignedToId ? (apprActorMap.get(step.assignedToId) ?? null) : null;

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_APPROVED",
      title: `Step approved: ${step.title}`,
      description: reviewerName
        ? `${reviewerName} approved "${step.title}"`
        : `Step "${step.title}" approved`,
      metadata: {
        previousStatus: "in_review",
        newStatus: "completed",
        reviewerId: performedById,
        reviewerName,
        assigneeId: step.assignedToId,
        assigneeName,
        moduleName: apprModName,
        stepTitle: step.title,
        timeTakenMs,
        note: notes?.trim() || null,
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    if (notes?.trim() && performedById) {
      await this.createStepNote(caseId, stepId, organizationId, performedById, notes.trim());
    }

    // Auto-assign next step within same module
    await this.autoAssignNextStep(
      caseId,
      stepId,
      organizationId,
      performedById,
    );

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Reject step (in_review → active with feedback) ─────────────────────────────

  async rejectStep(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    feedback?: string,
  ) {
    const [step] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, stepId),
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status !== "in_review") {
      log.warn("workflow.reject_rejected", { stepId, status: step.status });
      throw new BadRequestError("Step must be in_review to reject");
    }

    const now = new Date();
    let timeTakenMs: number | null = null;
    if (step.assignedAt) {
      timeTakenMs = now.getTime() - new Date(step.assignedAt).getTime();
    }

    await db
      .update(tasks)
      .set({
        // Terminal until the assignee reopens it: dropping straight back to
        // `in_progress` gave them no signal that anything had been rejected.
        status: "rejected",
        updatedAt: now,
      })
      .where(and(eq(tasks.id, stepId), eq(tasks.organizationId, organizationId)));

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "REJECTED",
      title: `Step rejected: ${step.title}`,
      actorId: performedById,
      note: feedback?.trim() || null,
      timeTakenMs,
    });

    await recordTaskReviewEvent({
      organizationId,
      taskKind: "case_step",
      taskId: stepId,
      caseId,
      action: "task.rejected",
      note: feedback,
      actorId: performedById,
    });

    const [rejModName, rejActorMap] = await Promise.all([
      resolveModuleName(step.workflowTemplateStepId),
      resolveStaffNames(performedById, step.assignedToId),
    ]);
    const rejReviewerName = performedById ? (rejActorMap.get(performedById) ?? null) : null;
    const rejAssigneeName = step.assignedToId ? (rejActorMap.get(step.assignedToId) ?? null) : null;

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_REJECTED",
      title: `Step rejected: ${step.title}`,
      description: rejReviewerName
        ? `${rejReviewerName} rejected "${step.title}"`
        : `Step "${step.title}" rejected`,
      metadata: {
        previousStatus: "in_review",
        newStatus: "rejected",
        feedback,
        reviewerId: performedById,
        reviewerName: rejReviewerName,
        assigneeId: step.assignedToId,
        assigneeName: rejAssigneeName,
        moduleName: rejModName,
        stepTitle: step.title,
        timeTakenMs,
        note: feedback?.trim() || null,
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    if (feedback?.trim() && performedById) {
      await this.createStepNote(caseId, stepId, organizationId, performedById, feedback.trim());
    }

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Reopen step (rejected → in_progress) ───────────────────────────────────────

  /**
   * Puts a rejected step back into the assignee's hands.
   *
   * Rejection is terminal until someone acts on the feedback, so returning to
   * `in_progress` is an explicit step rather than something the reviewer does
   * on the assignee's behalf. Mirrors `LeadWorkflowService.reopenTask`.
   */
  async reopenStep(
    caseId: string,
    stepId: string,
    organizationId: string,
    performedById?: string,
    notes?: string,
  ) {
    const [step] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, stepId),
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    // Kept in step with `TRANSITIONS.reopen` in tasks/task-transitions.service.ts,
    // which is the one place the lifecycle is defined — this method is what that
    // dispatches to for a case step. A step that was completed in error, or
    // skipped and later turns out to matter, must have a way back; otherwise the
    // firm's only options are a wrong record or a duplicate task beside it.
    if (!REOPENABLE_STATUSES.has(step.status)) {
      log.warn("workflow.reopen_rejected", { stepId, status: step.status });
      throw new BadRequestError(
        "Only rejected, completed or skipped steps can be reopened",
      );
    }

    const previousStatus = step.status;
    const now = new Date();

    await db
      .update(tasks)
      .set({
        status: "in_progress",
        completedAt: null,
        completedById: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, stepId),
          eq(tasks.organizationId, organizationId),
        ),
      );

    await logStepAction({
      organizationId,
      caseId,
      stepId,
      action: "REOPENED",
      title: `Step reopened: ${step.title}`,
      actorId: performedById,
      note: notes?.trim() || null,
    });

    await recordTaskReviewEvent({
      organizationId,
      taskKind: "case_step",
      taskId: stepId,
      caseId,
      action: "task.reopened",
      note: notes,
      actorId: performedById,
    });

    await logEvent({
      organizationId,
      caseId,
      stepId,
      eventType: "STEP_REOPENED",
      title: `Step reopened: ${step.title}`,
      description: `Step "${step.title}" reopened from ${previousStatus.replace("_", " ")}`,
      metadata: {
        previousStatus,
        newStatus: "in_progress",
        stepTitle: step.title,
        note: notes?.trim() || null,
        timestamp: now.toISOString(),
      },
      performedById: performedById ?? null,
    });

    return this.buildWorkflowResponse(caseId, organizationId);
  }

  // ─── Intelligent Staff Assignment Algorithm ─────────────────────────────────────

  // ─── Auto-assign next pending step after completion/approval ────────────────────

  private async autoAssignNextStep(
    caseId: string,
    currentStepId: string,
    organizationId: string,
    performedById?: string,
  ) {
    const allSteps = await db
      .select()
      .from(tasks)
      .innerJoin(
        workflowTemplateSteps,
        eq(tasks.workflowTemplateStepId, workflowTemplateSteps.id),
      )
      .innerJoin(
        workflowModules,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .where(
        and(
          eq(tasks.caseId, caseId),
          eq(tasks.organizationId, organizationId),
          isWorkflowTask,
        ),
      )
      .orderBy(
        asc(workflowModules.orderIndex),
        asc(workflowTemplateSteps.orderIndex),
      );

    const stepIndex = allSteps.findIndex(
      (row) => row.tasks.id === currentStepId,
    );
    if (stepIndex === -1 || stepIndex >= allSteps.length - 1) return;

    const nextStep = allSteps[stepIndex + 1].tasks;
    const nextStepTemplate = allSteps[stepIndex + 1].workflow_template_steps;
    const nextModuleId = nextStepTemplate.moduleId;
    const currentModuleId =
      allSteps[stepIndex].workflow_template_steps.moduleId;

    // Only auto-trigger within same module
    if (nextModuleId !== currentModuleId || nextStep.status !== "pending")
      return;

    // Team-only, like every other assignment on a case. A case with steps has a
    // team by construction — materialization refuses to run without one — but if
    // the team were cleared afterwards the next step simply stays unassigned.
    const teamId = await getCaseTeamId(organizationId, caseId);
    const pickedId = teamId
      ? await pickBestAssignee({
          organizationId,
          teamId,
          requiredCertifications: nextStepTemplate.requiredCertifications,
          assignableRoles: nextStepTemplate.assignableRoles,
          excludeStaffId: performedById,
        })
      : null;
    const picked = pickedId ? await resolveStaffNames(pickedId) : null;
    const pickedStaff = picked && pickedId ? picked.get(pickedId) : null;

    const now = new Date();
    const updateData: Record<string, unknown> = {
      status: "in_progress",
      updatedAt: now,
    };

    if (pickedId) {
      updateData.assignedToId = pickedId;
      updateData.assignedAt = now;

      const autoNextModName = await resolveModuleName(nextStep.workflowTemplateStepId);
      const autoNextActorMap = await resolveStaffNames(performedById);
      const autoAssignerName = performedById ? (autoNextActorMap.get(performedById) ?? null) : null;

      await logStepAction({
        organizationId,
        caseId,
        stepId: nextStep.id,
        action: "ASSIGNED",
        title: `Step auto-assigned: ${nextStep.title}`,
        assigneeId: pickedId,
      });

      await logEvent({
        organizationId,
        caseId,
        stepId: nextStep.id,
        eventType: "STEP_ASSIGNED",
        title: `Step auto-assigned: ${nextStep.title}`,
        description: autoAssignerName
          ? `${autoAssignerName} assigned "${nextStep.title}" to ${pickedStaff ?? "a team member"}`
          : `Assigned to ${pickedStaff ?? "a team member"}`,
        metadata: {
          assignmentStrategy: "workload_balanced",
          staffId: pickedId,
          staffName: pickedStaff ?? null,
          assignerId: performedById ?? null,
          assignerName: autoAssignerName,
          moduleName: autoNextModName,
          stepTitle: nextStep.title,
          timestamp: now.toISOString(),
        },
        performedById: performedById ?? null,
      });
    }

    await db
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, nextStep.id));
  }

  // ─── Case Notes ─────────────────────────────────────────────────────────────────

  async createNote(data: {
    caseId: string;
    organizationId: string;
    workflowModuleId?: string;
    taskId?: string;
    category?: string;
    visibility?: string;
    isPinned?: boolean;
    context?: string;
    content: string;
    createdByUserId: string;
  }) {
    const [note] = await db
      .insert(caseNotes)
      .values({
        organizationId: data.organizationId,
        caseId: data.caseId,
        workflowModuleId: data.workflowModuleId,
        taskId: data.taskId,
        category: (data.category as any) ?? "internal_strategy",
        visibility: (data.visibility as any) ?? "all_staff",
        isPinned: data.isPinned ?? false,
        context: (data.context as any) ?? "notes_tab",
        content: data.content,
        createdByUserId: data.createdByUserId,
      })
      .returning();

    await logCaseEvent({
      organizationId: data.organizationId,
      caseId: data.caseId,
      action: "case.note_created",
      
      summary: `Note added: "${data.content.substring(0, 80)}${data.content.length > 80 ? "..." : ""}"`,
      metadata: {
        noteId: note.id,
        category: note.category,
        visibility: note.visibility,
        context: note.context,
        isPinned: note.isPinned,
        contentPreview: data.content.substring(0, 100),
      },
      actorId: data.createdByUserId,
    });

    return note;
  }

  async getNotes(params: {
    caseId: string;
    userRole: string;
    userId: string;
    pinnedOnly?: boolean;
    authorId?: string;
    context?: string;
    page?: number;
    limit?: number;
  }) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 10;
    const offset = (page - 1) * limit;

    // Role-based visibility filtering
    const visibilityConditions = this.getVisibilityConditions(params.userRole);

    const conditions = [
      eq(caseNotes.caseId, params.caseId),
      ...visibilityConditions,
    ];

    if (params.pinnedOnly) {
      conditions.push(eq(caseNotes.isPinned, true));
    } else {
      conditions.push(eq(caseNotes.isPinned, false));
    }

    if (params.authorId) {
      conditions.push(eq(caseNotes.createdByUserId, params.authorId));
    }

    if (params.context) {
      conditions.push(eq(caseNotes.context, params.context as any));
    }

    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(caseNotes)
      .where(and(...conditions));

    const notes = await db
      .select({
        id: caseNotes.id,
        caseId: caseNotes.caseId,
        workflowModuleId: caseNotes.workflowModuleId,
        taskId: caseNotes.taskId,
        category: caseNotes.category,
        visibility: caseNotes.visibility,
        isPinned: caseNotes.isPinned,
        context: caseNotes.context,
        content: caseNotes.content,
        isEdited: caseNotes.isEdited,
        createdByUserId: caseNotes.createdByUserId,
        createdAt: caseNotes.createdAt,
        updatedAt: caseNotes.updatedAt,
        authorName: sql<string | null>`concat(${staff.firstName}, ' ', ${staff.lastName})`,
        authorRole: staff.role,
      })
      .from(caseNotes)
      .leftJoin(staff, eq(caseNotes.createdByUserId, staff.id))
      .where(and(...conditions))
      .orderBy(desc(caseNotes.isPinned), desc(caseNotes.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      data: notes,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    };
  }

  private getVisibilityConditions(userRole: string) {
    switch (userRole) {
      case "admin":
        return [];
      case "attorney":
        return [
          or(
            eq(caseNotes.visibility, "all_staff"),
            eq(caseNotes.visibility, "attorneys_only"),
          ),
        ];
      default:
        return [eq(caseNotes.visibility, "all_staff")];
    }
  }

  async toggleNotePin(noteId: string, caseId: string, organizationId?: string, actorId?: string) {
    const [existing] = await db
      .select()
      .from(caseNotes)
      .where(and(eq(caseNotes.id, noteId), eq(caseNotes.caseId, caseId)))
      .limit(1);

    if (!existing) throw new NotFoundError("Note not found");

    if (organizationId) {
      const [caseRow] = await db
        .select({ id: cases.id })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
        .limit(1);
      if (!caseRow) throw new NotFoundError("Note not found");
    }

    const newPinnedState = !existing.isPinned;

    await db
      .update(caseNotes)
      .set({ isPinned: newPinnedState, updatedAt: new Date() })
      .where(eq(caseNotes.id, noteId));

    if (organizationId) {
      await logCaseEvent({
        organizationId,
        caseId,
        action: newPinnedState ? "case.note_pinned" : "case.note_unpinned",
        
        summary: newPinnedState ? "Note pinned" : "Note unpinned",
        metadata: { noteId },
        actorId,
      });
    }

    return { isPinned: newPinnedState };
  }

  async bulkDeleteNotes(noteIds: string[], caseId: string, organizationId?: string, actorId?: string) {
    if (organizationId) {
      const [caseRow] = await db
        .select({ id: cases.id })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
        .limit(1);
      if (!caseRow) throw new NotFoundError("Notes not found");
    }

    await db
      .delete(caseNotes)
      .where(and(inArray(caseNotes.id, noteIds), eq(caseNotes.caseId, caseId)));

    if (organizationId) {
      await logCaseEvent({
        organizationId,
        caseId,
        action: "case.note_deleted",
        
        summary: `${noteIds.length} note(s) deleted`,
        metadata: { noteIds },
        actorId,
      });
    }
  }

  async bulkPinNotes(noteIds: string[], caseId: string, isPinned: boolean, organizationId?: string, actorId?: string) {
    if (organizationId) {
      const [caseRow] = await db
        .select({ id: cases.id })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)))
        .limit(1);
      if (!caseRow) throw new NotFoundError("Notes not found");
    }

    await db
      .update(caseNotes)
      .set({ isPinned, updatedAt: new Date() })
      .where(and(inArray(caseNotes.id, noteIds), eq(caseNotes.caseId, caseId)));

    if (organizationId) {
      await logCaseEvent({
        organizationId,
        caseId,
        action: isPinned ? "case.note_pinned" : "case.note_unpinned",
        
        summary: isPinned ? `${noteIds.length} note(s) pinned` : `${noteIds.length} note(s) unpinned`,
        metadata: { noteIds },
        actorId,
      });
    }
  }

  async updateNote(
    noteId: string,
    caseId: string,
    data: { content?: string; category?: string; visibility?: string; isPinned?: boolean },
    actorId?: string,
    organizationId?: string,
  ) {
    const [existing] = await db
      .select({
        id: caseNotes.id,
        caseId: caseNotes.caseId,
        content: caseNotes.content,
        category: caseNotes.category,
        visibility: caseNotes.visibility,
        isEdited: caseNotes.isEdited,
        createdByUserId: caseNotes.createdByUserId,
        createdAt: caseNotes.createdAt,
        updatedAt: caseNotes.updatedAt,
        organizationId: cases.organizationId,
      })
      .from(caseNotes)
      .innerJoin(cases, eq(caseNotes.caseId, cases.id))
      .where(and(eq(caseNotes.id, noteId), eq(caseNotes.caseId, caseId)))
      .limit(1);

    if (!existing) throw new NotFoundError("Note not found");

    if (organizationId && existing.organizationId !== organizationId) {
      throw new NotFoundError("Note not found");
    }

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (data.content !== undefined) {
      updateFields.content = data.content;
      updateFields.isEdited = true;
    }
    if (data.category !== undefined) updateFields.category = data.category;
    if (data.visibility !== undefined) updateFields.visibility = data.visibility;
    if (data.isPinned !== undefined) updateFields.isPinned = data.isPinned;

    const [updated] = await db
      .update(caseNotes)
      .set(updateFields)
      .where(eq(caseNotes.id, noteId))
      .returning();

    // Log note updated event
    await logCaseEvent({
      organizationId: existing.organizationId,
      caseId,
      action: "case.note_updated",
      
      summary: "Note updated",
      metadata: { noteId, contentPreview: data.content?.substring(0, 100) },
      actorId,
    });

    return updated;
  }

  async deleteNote(noteId: string, caseId: string, actorId?: string, organizationId?: string) {
    const [existing] = await db
      .select({
        id: caseNotes.id,
        caseId: caseNotes.caseId,
        content: caseNotes.content,
        organizationId: cases.organizationId,
      })
      .from(caseNotes)
      .innerJoin(cases, eq(caseNotes.caseId, cases.id))
      .where(and(eq(caseNotes.id, noteId), eq(caseNotes.caseId, caseId)))
      .limit(1);

    if (!existing) throw new NotFoundError("Note not found");

    if (organizationId && existing.organizationId !== organizationId) {
      throw new NotFoundError("Note not found");
    }

    // Log note deleted event before deleting
    await logCaseEvent({
      organizationId: existing.organizationId,
      caseId,
      action: "case.note_deleted",
      
      summary: "Note deleted",
      metadata: { noteId, content: existing.content },
      actorId,
    });

    await db.delete(caseNotes).where(eq(caseNotes.id, noteId));
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────────

  private async getCase(caseId: string, organizationId: string) {
    const [caseRecord] = await db
      .select()
      .from(cases)
      .where(
        and(eq(cases.id, caseId), eq(cases.organizationId, organizationId)),
      )
      .limit(1);
    if (!caseRecord) throw new NotFoundError("Case not found");
    return caseRecord;
  }
}

// ─── Standalone exported functions ──────────────────────────────────────────────

export async function logEvent(data: {
  organizationId: string;
  caseId: string;
  stepId?: string;
  moduleId?: string;
  eventType: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  performedById: string | null;
}) {
  const workflowToCaseAction: Record<string, AuditActionName> = {
    WORKFLOW_INITIALIZED: "case.workflow_initialized",
    MODULE_ACTIVATED: "case.module_activated",
    STEP_ASSIGNED: "case.step_assigned",
    STEP_COMPLETED: "case.step_completed",
    STEP_SUBMITTED_FOR_REVIEW: "case.step_submitted_for_review",
    STEP_APPROVED: "case.step_approved",
    STEP_REJECTED: "case.step_rejected",
    STEP_REOPENED: "case.step_reopened",
  };
  const action = workflowToCaseAction[data.eventType];
  if (!action) return;

  await recordAuditEvent({
    action,
    entityType: "case",
    entityId: data.caseId,
    parentEntityType: "case",
    parentEntityId: data.caseId,
    organizationId: data.organizationId,
    summary: data.description,
    metadata: {
      ...data.metadata,
      stepId: data.stepId,
      moduleId: data.moduleId,
    },
    actor: data.performedById ? { staffId: data.performedById } : undefined,
  });
}

export async function logStepAction(data: {
  organizationId: string;
  caseId: string;
  stepId: string;
  action: string;
  title: string;
  actorId?: string | null;
  assigneeId?: string | null;
  moduleId?: string | null;
  note?: string | null;
  timeTakenMs?: number | null;
  metadata?: Record<string, unknown> | null;
}) {
  const stepActionToAuditAction: Record<string, AuditActionName> = {
    COMPLETED: "case.step_completed",
    ASSIGNED: "case.step_assigned",
    SUBMITTED: "case.step_submitted_for_review",
    APPROVED: "case.step_approved",
    REJECTED: "case.step_rejected",
    REOPENED: "case.step_reopened",
    SKIPPED: "case.step_skipped",
    STARTED: "case.step_started",
  };
  const mappedAction = stepActionToAuditAction[data.action];
  if (!mappedAction) return;

  await recordAuditEvent({
    action: mappedAction,
    entityType: "case",
    entityId: data.caseId,
    parentEntityType: "case",
    parentEntityId: data.caseId,
    organizationId: data.organizationId,
    summary: data.title,
    before: data.note ? { note: data.note } : undefined,
    metadata: {
      stepId: data.stepId,
      moduleId: data.moduleId,
      assigneeId: data.assigneeId,
      timeTakenMs: data.timeTakenMs,
      ...data.metadata,
    },
    actor: data.actorId ? { staffId: data.actorId } : undefined,
  });
}
