import { and, asc, count, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { stepActionLogs } from "../../db/schema";
import { cases } from "../../db/schema/cases";
import { leaveRequests } from "../../db/schema/leave-requests";
import { staff } from "../../db/schema/staff";
import { certifications } from "../../db/schema/cases";
import { staffCertifications } from "../../db/schema/staff-certifications";
import {
  caseNotes,
  caseTimelineEvents,
  caseWorkflowSteps,
  workflowLog,
  workflowModules,
  workflowTemplateSteps,
  workflowTemplates,
} from "../../db/schema/workflow";
import { BadRequestError, NotFoundError } from "../../utils/error/app-error";
import { logCaseEvent } from "../cases/case-events.service";

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
    const caseRecord = await this.getCase(caseId, organizationId);

    const existingSteps = await db
      .select()
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .orderBy(asc(caseWorkflowSteps.orderIndex));

    if (existingSteps.length > 0) {
      return this.buildWorkflowResponse(caseId, organizationId);
    }

    if (!caseRecord.practiceAreaId) {
      return { caseId, modules: [], startedAt: null };
    }

    await hydrateCaseWorkflow({
      organizationId,
      caseId,
      practiceAreaId: caseRecord.practiceAreaId,
    });

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
        caseWorkflowSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
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
      if (row.case_workflow_steps.assignedToId)
        stepStaffIds.add(row.case_workflow_steps.assignedToId);
      if (row.case_workflow_steps.completedById)
        stepStaffIds.add(row.case_workflow_steps.completedById);
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
        activationCondition: string | null;
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
      const ts = row.workflow_template_steps;
      const cs = row.case_workflow_steps;
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
      const anyInProgress = stepStatuses.some(
        (s) => s === "in_progress" || s === "in_review",
      );
      const anyStarted = stepStatuses.some(
        (s) => s === "in_progress" || s === "in_review" || s === "completed",
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

    const firstModule = modulesWithStatus[0];
    const startedSteps = modules.filter(
      (r) => r.case_workflow_steps.status !== "pending",
    );
    const startedAt =
      startedSteps.length > 0
        ? startedSteps[0].case_workflow_steps.createdAt.toISOString()
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
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      );

    const totalSteps = steps.length;
    const completedSteps = steps.filter((s) => s.status === "completed").length;
    const percentage =
      totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

    const inProgressStep = steps.find((s) => s.status === "in_progress");
    let currentModuleName: string | null = null;
    let currentModuleId: string | null = null;

    if (inProgressStep?.templateStepId) {
      const [templateStep] = await db
        .select()
        .from(workflowTemplateSteps)
        .where(eq(workflowTemplateSteps.id, inProgressStep.templateStepId))
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
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
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
      .update(caseWorkflowSteps)
      .set({
        status: "completed",
        completedAt: now,
        completedById: performedById,
        timeTakenMs,
        updatedAt: now,
      })
      .where(and(eq(caseWorkflowSteps.id, stepId), eq(caseWorkflowSteps.organizationId, organizationId)));

    const [moduleName, staffMap] = await Promise.all([
      resolveModuleName(step.templateStepId),
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
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");

    const [staffMember] = await db
      .select()
      .from(staff)
      .where(eq(staff.id, staffId))
      .limit(1);

    if (!staffMember) throw new NotFoundError("Staff not found");

    const now = new Date();
    const updateData: Partial<typeof caseWorkflowSteps.$inferInsert> = {
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
      .update(caseWorkflowSteps)
      .set(updateData)
      .where(eq(caseWorkflowSteps.id, stepId));

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
      resolveModuleName(step.templateStepId),
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
    const moduleSteps = await db
      .select()
      .from(caseWorkflowSteps)
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
          eq(workflowTemplateSteps.moduleId, moduleId),
        ),
      )
      .orderBy(asc(caseWorkflowSteps.orderIndex))
      .limit(1);

    if (moduleSteps.length === 0)
      throw new NotFoundError("No steps found for this module in the case");

    const firstStep = moduleSteps[0].case_workflow_steps;
    if (firstStep.status === "pending") {
      await db
        .update(caseWorkflowSteps)
        .set({ status: "in_progress", updatedAt: new Date() })
        .where(eq(caseWorkflowSteps.id, firstStep.id));
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
    const events = await db
      .select({
        id: caseTimelineEvents.id,
        eventType: caseTimelineEvents.eventType,
        title: caseTimelineEvents.title,
        description: caseTimelineEvents.description,
        metadata: caseTimelineEvents.metadata,
        createdById: caseTimelineEvents.createdById,
        createdAt: caseTimelineEvents.createdAt,
      })
      .from(caseTimelineEvents)
      .innerJoin(cases, eq(caseTimelineEvents.caseId, cases.id))
      .where(and(eq(caseTimelineEvents.caseId, caseId), eq(cases.organizationId, organizationId)))
      .orderBy(asc(caseTimelineEvents.createdAt));

    // Fetch step action logs for all steps in this case
    const actionLogRows = await db
      .select({
        log: stepActionLogs,
        stepTitle: caseWorkflowSteps.title,
      })
      .from(stepActionLogs)
      .innerJoin(
        caseWorkflowSteps,
        eq(stepActionLogs.stepId, caseWorkflowSteps.id),
      )
      .where(and(eq(caseWorkflowSteps.caseId, caseId), eq(stepActionLogs.organizationId, organizationId)))
      .orderBy(asc(stepActionLogs.createdAt));

    const ACTION_EVENT_MAP: Record<string, string> = {
      ASSIGNED: "step_assigned",
      SUBMITTED: "step_submitted_for_review",
      APPROVED: "step_approved",
      REJECTED: "step_rejected",
      COMPLETED: "step_completed",
    };

    const actionEvents = actionLogRows.map(({ log, stepTitle }) => {
      const eventType =
        ACTION_EVENT_MAP[log.action] ?? log.action.toLowerCase();
      return {
        id: log.id,
        eventType,
        title: log.title,
        description: log.note ?? null,
        metadata: {
          ...((log.metadata ?? {}) as Record<string, unknown>),
          stepTitle,
          note: log.note,
          actorName: log.actorName,
          assigneeName: log.assigneeName,
          assigneeId: log.assigneeId,
          timeTakenMs: log.timeTakenMs,
          action: log.action,
        } as Record<string, unknown> | null,
        actorId: log.actorId,
        createdAt: log.createdAt,
      };
    });

    // Merge and sort by createdAt
    const timelineEntries: {
      id: string;
      eventType: string;
      title: string;
      description: string | null;
      metadata: Record<string, unknown> | null;
      actorId: string | null;
      createdAt: Date;
    }[] = [
      ...events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        title: e.title,
        description: e.description,
        metadata: e.metadata as Record<string, unknown> | null,
        actorId: e.createdById,
        createdAt: e.createdAt,
      })),
      ...actionEvents,
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

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
      .select()
      .from(workflowLog)
      .where(
        and(
          eq(workflowLog.caseId, caseId),
          eq(workflowLog.organizationId, organizationId),
        ),
      )
      .orderBy(asc(workflowLog.createdAt));

    const staffIds = logs
      .map((l) => l.performedById)
      .filter((id): id is string => id !== null);

    const staffMap = new Map<string, { id: string; name: string }>();
    if (staffIds.length > 0) {
      const staffRows = await db
        .select()
        .from(staff)
        .where(inArray(staff.id, staffIds));
      for (const s of staffRows) {
        staffMap.set(s.id, { id: s.id, name: `${s.firstName} ${s.lastName}` });
      }
    }

    return logs.map((l) => ({
      id: l.id,
      eventType: l.eventType,
      title: l.title,
      description: l.description,
      metadata: l.metadata,
      performedBy: l.performedById
        ? (staffMap.get(l.performedById) ?? null)
        : null,
      createdAt: l.createdAt.toISOString(),
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
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status !== "in_progress")
      throw new BadRequestError(
        "Step must be in_progress to submit for review",
      );

    const now = new Date();
    let timeTakenMs: number | null = null;
    if (step.assignedAt) {
      timeTakenMs = now.getTime() - new Date(step.assignedAt).getTime();
    }

    await db
      .update(caseWorkflowSteps)
      .set({ status: "in_review", updatedAt: now })
      .where(and(eq(caseWorkflowSteps.id, stepId), eq(caseWorkflowSteps.organizationId, organizationId)));

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

    const [subModName, subActorMap] = await Promise.all([
      resolveModuleName(step.templateStepId),
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
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status !== "in_review")
      throw new BadRequestError("Step must be in_review to approve");

    const now = new Date();
    let timeTakenMs: number | null = null;
    if (step.assignedAt) {
      timeTakenMs = now.getTime() - new Date(step.assignedAt).getTime();
    }

    await db
      .update(caseWorkflowSteps)
      .set({
        status: "completed",
        completedAt: now,
        completedById: performedById,
        timeTakenMs,
        updatedAt: now,
      })
      .where(and(eq(caseWorkflowSteps.id, stepId), eq(caseWorkflowSteps.organizationId, organizationId)));

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

    const [apprModName, apprActorMap] = await Promise.all([
      resolveModuleName(step.templateStepId),
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
      .from(caseWorkflowSteps)
      .where(
        and(
          eq(caseWorkflowSteps.id, stepId),
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!step) throw new NotFoundError("Step not found");
    if (step.status !== "in_review")
      throw new BadRequestError("Step must be in_review to reject");

    const now = new Date();
    let timeTakenMs: number | null = null;
    if (step.assignedAt) {
      timeTakenMs = now.getTime() - new Date(step.assignedAt).getTime();
    }

    await db
      .update(caseWorkflowSteps)
      .set({
        status: "in_progress",
        updatedAt: now,
      })
      .where(and(eq(caseWorkflowSteps.id, stepId), eq(caseWorkflowSteps.organizationId, organizationId)));

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

    const [rejModName, rejActorMap] = await Promise.all([
      resolveModuleName(step.templateStepId),
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
        newStatus: "in_progress",
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
      .from(caseWorkflowSteps)
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .innerJoin(
        workflowModules,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .where(
        and(
          eq(caseWorkflowSteps.caseId, caseId),
          eq(caseWorkflowSteps.organizationId, organizationId),
        ),
      )
      .orderBy(
        asc(workflowModules.orderIndex),
        asc(workflowTemplateSteps.orderIndex),
      );

    const stepIndex = allSteps.findIndex(
      (row) => row.case_workflow_steps.id === currentStepId,
    );
    if (stepIndex === -1 || stepIndex >= allSteps.length - 1) return;

    const nextStep = allSteps[stepIndex + 1].case_workflow_steps;
    const nextModuleId =
      allSteps[stepIndex + 1].workflow_template_steps.moduleId;
    const currentModuleId =
      allSteps[stepIndex].workflow_template_steps.moduleId;

    // Only auto-trigger within same module
    if (nextModuleId !== currentModuleId || nextStep.status !== "pending")
      return;

    const picked = await pickBestStaff(
      organizationId,
      nextStep.templateStepId,
      performedById,
    );

    const now = new Date();
    const updateData: Record<string, unknown> = {
      status: "in_progress",
      updatedAt: now,
    };

    if (picked) {
      updateData.assignedToId = picked.id;
      updateData.assignedAt = now;

      const autoNextModName = await resolveModuleName(nextStep.templateStepId);
      const autoNextActorMap = await resolveStaffNames(performedById);
      const autoAssignerName = performedById ? (autoNextActorMap.get(performedById) ?? null) : null;

      await logStepAction({
        organizationId,
        caseId,
        stepId: nextStep.id,
        action: "ASSIGNED",
        title: `Step auto-assigned: ${nextStep.title}`,
        assigneeId: picked.id,
      });

      await logEvent({
        organizationId,
        caseId,
        stepId: nextStep.id,
        eventType: "STEP_ASSIGNED",
        title: `Step auto-assigned: ${nextStep.title}`,
        description: autoAssignerName
          ? `${autoAssignerName} assigned "${nextStep.title}" to ${picked.firstName} ${picked.lastName}`
          : `Assigned to ${picked.firstName} ${picked.lastName}`,
        metadata: {
          assignmentStrategy: "workload_balanced",
          staffId: picked.id,
          staffName: `${picked.firstName} ${picked.lastName}`,
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
      .update(caseWorkflowSteps)
      .set(updateData)
      .where(eq(caseWorkflowSteps.id, nextStep.id));
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
      eventType: "case_note_created",
      title: "Note added",
      description: `Note added: "${data.content.substring(0, 80)}${data.content.length > 80 ? "..." : ""}"`,
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
        eventType: newPinnedState ? "case_note_pinned" : "case_note_unpinned",
        title: newPinnedState ? "Note pinned" : "Note unpinned",
        description: newPinnedState ? "Note pinned" : "Note unpinned",
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
        eventType: "case_note_deleted",
        title: `${noteIds.length} note(s) deleted`,
        description: `${noteIds.length} note(s) deleted`,
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
        eventType: isPinned ? "case_note_pinned" : "case_note_unpinned",
        title: isPinned ? `${noteIds.length} note(s) pinned` : `${noteIds.length} note(s) unpinned`,
        description: isPinned ? `${noteIds.length} note(s) pinned` : `${noteIds.length} note(s) unpinned`,
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
      eventType: "case_note_updated",
      title: "Note updated",
      description: "Note updated",
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
      eventType: "case_note_deleted",
      title: "Note deleted",
      description: "Note deleted",
      metadata: { noteId, content: existing.content },
      actorId,
    });

    await db.delete(caseNotes).where(eq(caseNotes.id, noteId));
  }

  // ─── Get my assigned tasks (for current staff member) ────────────────────────────

  async getMyTasks(
    staffId: string,
    organizationId: string,
    status?: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const statuses = (
      status
        ? status.split(",")
        : ["in_progress", "in_review", "completed", "pending", "skipped"]
    ) as ("completed" | "pending" | "in_progress" | "in_review" | "skipped")[];

    const baseConditions = and(
      eq(caseWorkflowSteps.assignedToId, staffId),
      eq(caseWorkflowSteps.organizationId, organizationId),
    );

    const countRows = await db
      .select({
        status: caseWorkflowSteps.status,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(caseWorkflowSteps)
      .where(baseConditions)
      .groupBy(caseWorkflowSteps.status);

    const counts: Record<string, number> = {
      in_progress: 0,
      in_review: 0,
      completed: 0,
      pending: 0,
      skipped: 0,
    };
    for (const r of countRows) {
      counts[r.status] = r.count;
    }

    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(caseWorkflowSteps)
      .where(and(baseConditions, inArray(caseWorkflowSteps.status, statuses)));
    const total = Number(count);

    const filteredConditions = and(
      baseConditions,
      inArray(caseWorkflowSteps.status, statuses),
    );

    const offset = (page - 1) * limit;

    const rows = await db
      .select({
        stepId: caseWorkflowSteps.id,
        stepTitle: caseWorkflowSteps.title,
        stepStatus: caseWorkflowSteps.status,
        stepAssignedAt: caseWorkflowSteps.assignedAt,
        stepDueDate: caseWorkflowSteps.dueDate,
        stepCreatedAt: caseWorkflowSteps.createdAt,
        stepNotes: caseWorkflowSteps.notes,
        stepUpdatedAt: caseWorkflowSteps.updatedAt,
        caseTitle: cases.caseNumber,
        caseId: cases.id,
        moduleName: workflowModules.name,
        moduleId: workflowModules.id,
        phaseName: workflowModules.phase,
      })
      .from(caseWorkflowSteps)
      .innerJoin(cases, eq(caseWorkflowSteps.caseId, cases.id))
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .innerJoin(
        workflowModules,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .where(filteredConditions)
      .orderBy(asc(caseWorkflowSteps.dueDate), asc(caseWorkflowSteps.createdAt))
      .limit(limit)
      .offset(offset);

    // Fetch step action logs for these steps
    const stepIds = rows.map((r) => r.stepId);
    const actionLogs =
      stepIds.length > 0
        ? await db
            .select()
            .from(stepActionLogs)
            .where(inArray(stepActionLogs.stepId, stepIds))
            .orderBy(asc(stepActionLogs.createdAt))
        : [];
    const logsByStep = new Map<string, typeof actionLogs>();
    for (const log of actionLogs) {
      const list = logsByStep.get(log.stepId) ?? [];
      list.push(log);
      logsByStep.set(log.stepId, list);
    }

    const data = rows.map((r) => ({
      stepId: r.stepId,
      caseId: r.caseId,
      caseTitle: r.caseTitle,
      title: r.stepTitle,
      status: r.stepStatus,
      moduleId: r.moduleId,
      moduleName: r.moduleName,
      phaseName: r.phaseName,
      assignedAt: r.stepAssignedAt?.toISOString() ?? null,
      dueDate: r.stepDueDate,
      createdAt: r.stepCreatedAt.toISOString(),
      updatedAt: r.stepUpdatedAt.toISOString(),
      auditLog: logsByStep.get(r.stepId) ?? [],
    }));

    return { data, counts, pagination: { total, limit, offset } };
  }

  // ─── Get review queue (all in_review steps across all cases) ────────────────────

  async getReviewQueue(
    organizationId: string,
    status?: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const statuses = (status ? status.split(",") : ["in_review"]) as (
      "completed" | "pending" | "in_progress" | "in_review" | "skipped"
    )[];

    const baseOrgCondition = eq(
      caseWorkflowSteps.organizationId,
      organizationId,
    );

    const countRows = await db
      .select({
        status: caseWorkflowSteps.status,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(caseWorkflowSteps)
      .where(baseOrgCondition)
      .groupBy(caseWorkflowSteps.status);

    const counts: Record<string, number> = {
      in_progress: 0,
      in_review: 0,
      completed: 0,
      pending: 0,
      skipped: 0,
    };
    for (const r of countRows) {
      counts[r.status] = r.count;
    }

    const baseConditions = and(
      baseOrgCondition,
      inArray(caseWorkflowSteps.status, statuses),
    );

    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(caseWorkflowSteps)
      .innerJoin(cases, eq(caseWorkflowSteps.caseId, cases.id))
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .innerJoin(
        workflowModules,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .leftJoin(staff, eq(caseWorkflowSteps.assignedToId, staff.id))
      .where(baseConditions);
    const total = Number(count);

    const offset = (page - 1) * limit;

    const rows = await db
      .select({
        stepId: caseWorkflowSteps.id,
        stepTitle: caseWorkflowSteps.title,
        stepStatus: caseWorkflowSteps.status,
        stepUpdatedAt: caseWorkflowSteps.updatedAt,
        stepDueDate: caseWorkflowSteps.dueDate,
        stepNotes: caseWorkflowSteps.notes,
        caseTitle: cases.caseNumber,
        caseId: cases.id,
        moduleName: workflowModules.name,
        moduleId: workflowModules.id,
        phaseName: workflowModules.phase,
        assigneeFirstName: staff.firstName,
        assigneeLastName: staff.lastName,
      })
      .from(caseWorkflowSteps)
      .innerJoin(cases, eq(caseWorkflowSteps.caseId, cases.id))
      .innerJoin(
        workflowTemplateSteps,
        eq(caseWorkflowSteps.templateStepId, workflowTemplateSteps.id),
      )
      .innerJoin(
        workflowModules,
        eq(workflowTemplateSteps.moduleId, workflowModules.id),
      )
      .leftJoin(staff, eq(caseWorkflowSteps.assignedToId, staff.id))
      .where(baseConditions)
      .orderBy(asc(caseWorkflowSteps.updatedAt))
      .limit(limit)
      .offset(offset);

    // Fetch step action logs for these steps
    const stepIds = rows.map((r) => r.stepId);
    const actionLogs =
      stepIds.length > 0
        ? await db
            .select()
            .from(stepActionLogs)
            .where(inArray(stepActionLogs.stepId, stepIds))
            .orderBy(asc(stepActionLogs.createdAt))
        : [];
    const logsByStep = new Map<string, typeof actionLogs>();
    for (const log of actionLogs) {
      const list = logsByStep.get(log.stepId) ?? [];
      list.push(log);
      logsByStep.set(log.stepId, list);
    }

    const data = rows.map((r) => ({
      stepId: r.stepId,
      caseId: r.caseId,
      caseTitle: r.caseTitle,
      title: r.stepTitle,
      status: r.stepStatus,
      moduleId: r.moduleId,
      moduleName: r.moduleName,
      phaseName: r.phaseName,
      assignedToName:
        r.assigneeFirstName && r.assigneeLastName
          ? `${r.assigneeFirstName} ${r.assigneeLastName}`
          : null,
      submittedAt: r.stepUpdatedAt?.toISOString() ?? null,
      dueDate: r.stepDueDate,
      auditLog: logsByStep.get(r.stepId) ?? [],
    }));

    return { data, counts, pagination: { total, limit, offset } };
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

export async function pickBestStaff(
  organizationId: string,
  templateStepId?: string | null,
  excludeStaffId?: string,
): Promise<{ id: string; firstName: string; lastName: string } | null> {

  let candidates = await db
    .select()
    .from(staff)
    .where(
      and(
        eq(staff.organizationId, organizationId),
        eq(staff.status, "active"),
        excludeStaffId ? ne(staff.id, excludeStaffId) : undefined,
      ),
    );

  if (candidates.length === 0) {
    candidates = await db
      .select()
      .from(staff)
      .where(
        and(
          eq(staff.organizationId, organizationId),
          ne(staff.status, "inactive"),
          excludeStaffId ? ne(staff.id, excludeStaffId) : undefined,
        ),
      );
  }

  if (candidates.length === 0) return null;

  if (templateStepId) {
    const [templateStep] = await db
      .select()
      .from(workflowTemplateSteps)
      .where(eq(workflowTemplateSteps.id, templateStepId))
      .limit(1);

    const requiredCert = templateStep?.requiredCertification;
    if (requiredCert) {
      const certifiedStaffIds = await db
        .select({ staffId: staffCertifications.staffId })
        .from(staffCertifications)
        .innerJoin(certifications, eq(certifications.id, staffCertifications.certificationId))
        .where(eq(certifications.name, requiredCert));

      const certSet = new Set(certifiedStaffIds.map((r) => r.staffId));
      candidates = candidates.filter((s) => certSet.has(s.id));
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return {
      id: candidates[0].id,
      firstName: candidates[0].firstName,
      lastName: candidates[0].lastName,
    };
  }

  const todayStr = new Date().toISOString().split("T")[0];
  const staffOnLeave = await db
    .select({ staffId: leaveRequests.staffId })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.organizationId, organizationId),
        eq(leaveRequests.status, "approved"),
        lte(leaveRequests.startDate, todayStr),
        gte(leaveRequests.endDate, todayStr),
      ),
    );

  const leaveSet = new Set(staffOnLeave.map((r) => r.staffId));
  const availableStaff = candidates.filter((s) => !leaveSet.has(s.id));
  const pool = availableStaff.length > 0 ? availableStaff : candidates;

  const staffIds = pool.map((s) => s.id);
  const loadRows = await db
    .select({
      staffId: caseWorkflowSteps.assignedToId,
      taskCount: count(),
    })
    .from(caseWorkflowSteps)
    .where(
      and(
        inArray(caseWorkflowSteps.assignedToId, staffIds),
        inArray(caseWorkflowSteps.status, ["in_progress", "in_review"]),
      ),
    )
    .groupBy(caseWorkflowSteps.assignedToId);

  const loadMap = new Map<string, number>();
  for (const row of loadRows) {
    if (row.staffId) loadMap.set(row.staffId, row.taskCount);
  }

  const recentAssignments = await db
    .select({
      staffId: caseWorkflowSteps.assignedToId,
      lastAssigned: sql<string>`MAX(${caseWorkflowSteps.assignedAt})`.as("last_assigned"),
    })
    .from(caseWorkflowSteps)
    .where(
      and(
        inArray(caseWorkflowSteps.assignedToId, staffIds),
        sql`${caseWorkflowSteps.assignedAt} IS NOT NULL`,
      ),
    )
    .groupBy(caseWorkflowSteps.assignedToId);

  const lastAssignedMap = new Map<string, Date>();
  for (const row of recentAssignments) {
    if (row.staffId) lastAssignedMap.set(row.staffId, new Date(row.lastAssigned));
  }

  const scored = pool.map((s) => ({
    staff: s,
    load: loadMap.get(s.id) ?? 0,
    lastAssigned: lastAssignedMap.get(s.id) ?? null,
  }));

  scored.sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    if (a.lastAssigned && b.lastAssigned) {
      return a.lastAssigned.getTime() - b.lastAssigned.getTime();
    }
    if (!a.lastAssigned && b.lastAssigned) return -1;
    if (a.lastAssigned && !b.lastAssigned) return 1;
    return 0;
  });

  const picked = scored[0];
  return {
    id: picked.staff.id,
    firstName: picked.staff.firstName,
    lastName: picked.staff.lastName,
  };
}

// ─── Hydrate case workflow from template ──────────────────────────────────────

export async function hydrateCaseWorkflow(data: {
  organizationId: string;
  caseId: string;
  practiceAreaId: string;
}): Promise<{
  workflowSteps: (typeof caseWorkflowSteps.$inferSelect)[];
  template: (typeof workflowTemplates.$inferSelect) | null;
}> {
  const [template] = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.practiceAreaId, data.practiceAreaId))
    .limit(1);

  if (!template) return { workflowSteps: [], template: null };

  const modules = await db
    .select()
    .from(workflowModules)
    .where(eq(workflowModules.templateId, template.id))
    .orderBy(asc(workflowModules.orderIndex));

  const allTemplateSteps = await db
    .select()
    .from(workflowTemplateSteps)
    .where(
      inArray(
        workflowTemplateSteps.moduleId,
        modules.map((m) => m.id),
      ),
    )
    .orderBy(asc(workflowTemplateSteps.orderIndex));

  const moduleStepMap = new Map<string, typeof allTemplateSteps>();
  for (const step of allTemplateSteps) {
    const list = moduleStepMap.get(step.moduleId) ?? [];
    list.push(step);
    moduleStepMap.set(step.moduleId, list);
  }

  const stepInserts: (typeof caseWorkflowSteps.$inferInsert)[] = [];
  let isFirstStep = true;

  for (const mod of modules) {
    const templateSteps = moduleStepMap.get(mod.id) ?? [];
    for (const ts of templateSteps) {
      stepInserts.push({
        organizationId: data.organizationId,
        caseId: data.caseId,
        templateStepId: ts.id,
        title: ts.title,
        description: ts.description,
        orderIndex: mod.orderIndex * 100 + ts.orderIndex,
        dueDate: ts.dueInDays
          ? new Date(Date.now() + ts.dueInDays * 86400000)
              .toISOString()
              .split("T")[0]
          : null,
        status: isFirstStep ? "in_progress" : "pending",
        assignedToId: null,
      });
      isFirstStep = false;
    }
  }

  if (stepInserts.length === 0) return { workflowSteps: [], template };

  const workflowSteps = await db
    .insert(caseWorkflowSteps)
    .values(stepInserts)
    .returning();

  const [firstStep] = workflowSteps;
  if (firstStep) {
    const picked = await pickBestStaff(
      data.organizationId,
      firstStep.templateStepId,
      undefined,
    );

    if (picked) {
      const now = new Date();
      await db
        .update(caseWorkflowSteps)
        .set({
          assignedToId: picked.id,
          assignedAt: now,
          updatedAt: now,
        })
        .where(eq(caseWorkflowSteps.id, firstStep.id));

      firstStep.assignedToId = picked.id;
      firstStep.assignedAt = now;

      const autoModuleName = await resolveModuleName(firstStep.templateStepId);

      await logStepAction({
        organizationId: data.organizationId,
        caseId: data.caseId,
        stepId: firstStep.id,
        action: "ASSIGNED",
        title: `Step auto-assigned: ${firstStep.title}`,
        assigneeId: picked.id,
      });

      await logEvent({
        organizationId: data.organizationId,
        caseId: data.caseId,
        stepId: firstStep.id,
        eventType: "STEP_ASSIGNED",
        title: `Step auto-assigned: ${firstStep.title}`,
        description: `System assigned "${firstStep.title}" to ${picked.firstName} ${picked.lastName}`,
        metadata: {
          assignmentStrategy: "workload_balanced",
          staffId: picked.id,
          staffName: `${picked.firstName} ${picked.lastName}`,
          moduleName: autoModuleName,
          stepTitle: firstStep.title,
          assignerId: null,
          assignerName: "System",
          timestamp: now.toISOString(),
        },
        performedById: null,
      });
    }
  }

  await logEvent({
    organizationId: data.organizationId,
    caseId: data.caseId,
    eventType: "WORKFLOW_INITIALIZED",
    title: "Workflow initialized",
    description: "Hydrated from template",
    metadata: {
      stepCount: stepInserts.length,
      moduleCount: modules.length,
      templateId: template.id,
      timestamp: new Date().toISOString(),
    },
    performedById: null,
  });

  return { workflowSteps, template };
}

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
  await db.insert(workflowLog).values({
    organizationId: data.organizationId,
    caseId: data.caseId,
    stepId: data.stepId,
    moduleId: data.moduleId,
    eventType: data.eventType,
    title: data.title,
    description: data.description,
    metadata: (data.metadata as any) ?? null,
    performedById: data.performedById,
  });

  // Mirror to unified case_events table
  const workflowToCaseEventMap: Record<string, string> = {
    WORKFLOW_INITIALIZED: "workflow_initialized",
    MODULE_ACTIVATED: "module_activated",
    STEP_ASSIGNED: "step_assigned",
    STEP_COMPLETED: "step_completed",
    STEP_SUBMITTED_FOR_REVIEW: "step_submitted_for_review",
    STEP_APPROVED: "step_approved",
    STEP_REJECTED: "step_rejected",
  };
  const caseEventType = workflowToCaseEventMap[data.eventType];
  if (caseEventType) {
    await logCaseEvent({
      organizationId: data.organizationId,
      caseId: data.caseId,
      eventType: caseEventType,
      title: data.title,
      description: data.description,
      metadata: {
        ...data.metadata,
        stepId: data.stepId,
        moduleId: data.moduleId,
      },
      actorId: data.performedById,
    });
  }
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
  const staffIds = [data.actorId, data.assigneeId].filter(
    (id): id is string => id != null,
  );
  const nameMap = new Map<string, string>();
  if (staffIds.length > 0) {
    const rows = await db
      .select({
        id: staff.id,
        firstName: staff.firstName,
        lastName: staff.lastName,
      })
      .from(staff)
      .where(inArray(staff.id, staffIds));
    for (const s of rows) {
      nameMap.set(s.id, `${s.firstName} ${s.lastName}`);
    }
  }

  await db.insert(stepActionLogs).values({
    organizationId: data.organizationId,
    caseId: data.caseId,
    stepId: data.stepId,
    moduleId: data.moduleId ?? null,
    action: data.action,
    title: data.title,
    actorId: data.actorId ?? null,
    actorName: data.actorId ? (nameMap.get(data.actorId) ?? null) : null,
    assigneeId: data.assigneeId ?? null,
    assigneeName: data.assigneeId ? (nameMap.get(data.assigneeId) ?? null) : null,
    note: data.note ?? null,
    timeTakenMs: data.timeTakenMs ?? null,
    metadata: (data.metadata as any) ?? null,
  });
}
