import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { cases } from "../../db/schema/cases";
import { tasks } from "../../db/schema/tasks";
import {
  workflowModuleActivations,
  workflowModules,
  workflowTemplateSteps,
} from "../../db/schema/workflow";
import {
  buildConditionContext,
  conditionHasUnansweredInput,
  evaluateCondition,
} from "./condition-evaluator";
import { resolveDueDate } from "./due-date-resolver";
import { resolveWorkflowTemplateId } from "./workflow-template.service";
import { pickBestAssignee } from "./assignment.service";
import { recordAuditEvent } from "../shared/audit.service";
import { createModuleLogger } from "../../lib/logging/log";
import { BadRequestError } from "../../utils/error/app-error";

const log = createModuleLogger("workflow.task-materialization");

/**
 * The one sentence every "this case has no team yet" refusal says.
 *
 * Shared so the workflow tab, the activate button and anything else that trips
 * over it tell a person the same thing to go and do.
 */
export const NO_TEAM_MESSAGE =
  "Assign a team to this case before generating its workflow — every step is assigned from the case's team.";

type TemplateModule = typeof workflowModules.$inferSelect;
type TemplateStep = typeof workflowTemplateSteps.$inferSelect;

/**
 * The statuses a withdrawal is allowed to touch.
 *
 * Open work only. A step that was completed, rejected or deliberately skipped
 * is part of the record of what happened on this matter — the condition turning
 * false later does not make it untrue that the work was done, and rewriting it
 * would revise history the same way regenerating an audit summary would.
 *
 * `in_progress` is included deliberately, even though someone is mid-way
 * through it. The work no longer applies, and leaving it open so the board
 * keeps demanding it is the defect being fixed; the audit row and the restore
 * path are what make that safe.
 */
const WITHDRAWABLE_STATUSES = ["pending", "in_progress", "in_review"] as const;

/**
 * Retires open tasks belonging to modules whose condition stopped holding.
 *
 * Withdrawal, not deletion. The task keeps its id, its notes, its assignee and
 * its history; it changes status to `cancelled` and leaves the board's live
 * counts. A condition flips false because of a typo at least as often as
 * because a fact changed, so this has to be reversible — `materializeTasksForCase`
 * restores anything it finds withdrawn under a module that is active again.
 *
 * `cancelled` rather than `skipped` because the two mean different things and
 * the distinction is worth keeping: `skipped` is a person deciding this step is
 * not needed (`case.step_skipped`), `cancelled` is the engine observing that it
 * no longer applies.
 */
async function withdrawInactiveModules(params: {
  caseId: string;
  organizationId: string;
  inactiveModules: TemplateModule[];
  stepsByModule: Map<string, TemplateStep[]>;
  taskByStepId: Map<string, { id: string; title: string; status: string }>;
}): Promise<number> {
  const { caseId, organizationId, inactiveModules, stepsByModule, taskByStepId } = params;

  let withdrawn = 0;

  for (const mod of inactiveModules) {
    for (const step of stepsByModule.get(mod.id) ?? []) {
      const task = taskByStepId.get(step.id);
      if (!task) continue;
      if (!WITHDRAWABLE_STATUSES.includes(task.status as (typeof WITHDRAWABLE_STATUSES)[number])) {
        continue;
      }

      await db
        .update(tasks)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(tasks.id, task.id));

      await recordAuditEvent({
        action: "case.step_withdrawn",
        entityType: "workflow_step",
        entityId: task.id,
        parentEntityType: "case",
        parentEntityId: caseId,
        organizationId,
        summary: `"${task.title}" withdrawn — ${mod.name} no longer applies to this matter`,
        metadata: {
          moduleId: mod.id,
          moduleName: mod.name,
          previousStatus: task.status,
          workflowTemplateStepId: step.id,
        },
      });

      withdrawn++;
    }
  }

  if (withdrawn > 0) log.action("workflow.tasks_withdrawn", { caseId, withdrawn });
  return withdrawn;
}

/**
 * Brings a withdrawn task back when its module's condition holds again.
 *
 * Returns to `pending` rather than to whatever it was before. A task withdrawn
 * mid-`in_progress` has had an unknown amount of time pass and its work may no
 * longer be valid, so it comes back as work to be picked up, not as work
 * someone is presumed to still be holding. The previous status is in the
 * withdrawal's audit metadata for anyone who needs it.
 *
 * The due date is left alone — `reresolveDueDates` owns that and runs on its
 * own triggers.
 */
async function restoreTask(params: {
  taskId: string;
  caseId: string;
  organizationId: string;
  mod: TemplateModule;
  title: string;
}): Promise<void> {
  const { taskId, caseId, organizationId, mod, title } = params;

  await db
    .update(tasks)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(tasks.id, taskId));

  await recordAuditEvent({
    action: "case.step_restored",
    entityType: "workflow_step",
    entityId: taskId,
    parentEntityType: "case",
    parentEntityId: caseId,
    organizationId,
    summary: `"${title}" restored — ${mod.name} applies to this matter again`,
    metadata: { moduleId: mod.id, moduleName: mod.name },
  });

  log.action("workflow.task_restored", { caseId, taskId, moduleId: mod.id });
}

/**
 * Creates one task from one template step, and auto-assigns it if the step
 * names a role.
 *
 * The single place a workflow task is born — shared by the whole-case pass and
 * by `materializeModule`, so a manually activated module produces tasks
 * identical in every respect (phase, order, lock flag, assignment) to one that
 * activated on its own. When these were two code paths they diverged, which is
 * the kind of difference nobody notices until a locked step turns out not to be
 * locked.
 */
async function materializeStep(params: {
  caseId: string;
  organizationId: string;
  /** The case's team. Every candidate for this step comes from it — see `pickBestAssignee`. */
  teamId: string;
  mod: TemplateModule;
  step: TemplateStep;
  /** Per-step audit rows are for incremental passes; the first pass gets one summary row. */
  auditStepCreated: boolean;
}): Promise<void> {
  const { caseId, organizationId, mod, step } = params;

  const dueDate = await resolveDueDate(
    caseId,
    step.dueDateAnchor,
    step.dueDateOffsetDays,
    mod.id,
  );

  const [inserted] = await db
    .insert(tasks)
    .values({
      organizationId,
      caseId,
      source: "workflow",
      workflowTemplateStepId: step.id,
      title: step.title,
      description: step.description,
      // The five guidance fields travel with the task for the same reason the
      // title does: this row is the record of the work as it was handed out.
      purpose: step.purpose,
      guidance: step.guidance,
      doneWhen: step.doneWhen,
      pitfalls: step.pitfalls,
      authority: step.authority,
      // Denormalized at creation: `phase` is the stable display grouping, and a
      // later template edit must not retitle work already on someone's queue.
      phase: mod.phase,
      orderIndex: mod.orderIndex * 1000 + step.orderIndex,
      isRequired: step.isRequired,
      isLocked: step.isLocked,
      requiredCertifications: step.requiredCertifications,
      status: "pending",
      dueDate,
    })
    .returning();

  if (params.auditStepCreated) {
    await recordAuditEvent({
      action: "case.step_created",
      entityType: "workflow_step",
      entityId: inserted.id,
      parentEntityType: "case",
      parentEntityId: caseId,
      organizationId,
      summary: `Step added from module "${mod.name}": ${step.title}`,
      metadata: { moduleId: mod.id, templateStepId: step.id, phase: mod.phase },
    });
  }

  if (step.assignableRoles.length > 0) {
    // Team-only, and null when nobody on the team matches — the step then lands
    // unassigned for someone to hand out, rather than being routed off the team.
    const staffId = await pickBestAssignee({
      organizationId,
      teamId: params.teamId,
      requiredCertifications: step.requiredCertifications,
      assignableRoles: step.assignableRoles,
    });
    if (staffId) {
      /*
        Assigned, not started. The status stays `pending` until the person
        holding it presses Start.

        Being given work is not the same as beginning it. Stamping
        `in_progress` at assignment made the board claim every freshly
        materialized step was underway, so "in progress" meant nothing, a
        matter looked half-worked the moment it opened, and nobody could tell
        which of their twenty tasks they had actually picked up. It also made
        auto-assignment behave differently from a person assigning by hand,
        which leaves the status alone (`reassignTask`).
      */
      await db
        .update(tasks)
        .set({ assignedToId: staffId, assignedAt: new Date() })
        .where(eq(tasks.id, inserted.id));
    }
  }
}

/**
 * Instantiates a case's tasks from its resolved workflow template.
 *
 * Idempotent — safe to call again for the same case (e.g. after a conditional
 * module's condition newly evaluates true): `auto` and now-true `conditional`
 * modules materialize any steps that don't already have a task, `manual`
 * modules stay untouched until a staff member explicitly activates them (see
 * `activateModule` in workflow.service.ts), and already-materialized tasks are
 * left alone — a template edit never rewrites a case's already-created tasks,
 * same as `caseTypeDocumentRequirements`.
 *
 * Call sites: case creation, case-type change, and anywhere the two
 * practice-area extension tables get updated in a way that could flip a
 * conditional module's condition (e.g. `filingTrack` sequential → concurrent).
 */
export async function materializeTasksForCase(caseId: string): Promise<void> {
  const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!caseRow) return;

  // A case can be opened before anyone decides who is working it, but its
  // workflow cannot be generated until then: every step is assigned from the
  // case's team, so generating now would produce a full board of unassignable
  // work. Returns rather than throws — the callers are case creation and
  // case-type changes, which must still succeed. `getWorkflow` is where a person
  // is told why the board is empty.
  if (!caseRow.assignedTeamId) {
    log.warn("workflow.team_missing", { caseId });
    return;
  }

  const templateId = await resolveWorkflowTemplateId(caseRow.organizationId, caseRow.caseTypeId);
  if (!templateId) {
    log.warn("workflow.template_missing", { caseId, caseTypeId: caseRow.caseTypeId });
    return;
  }

  const modules = await db
    .select()
    .from(workflowModules)
    .where(eq(workflowModules.templateId, templateId))
    .orderBy(asc(workflowModules.orderIndex));
  if (modules.length === 0) return;

  const allSteps = await db
    .select()
    .from(workflowTemplateSteps)
    .where(inArray(workflowTemplateSteps.moduleId, modules.map((m) => m.id)))
    .orderBy(asc(workflowTemplateSteps.orderIndex));

  const stepsByModule = new Map<string, typeof allSteps>();
  for (const step of allSteps) {
    const list = stepsByModule.get(step.moduleId) ?? [];
    list.push(step);
    stepsByModule.set(step.moduleId, list);
  }

  const ctx = await buildConditionContext(caseId, caseRow.organizationId);

  // Status comes along because this pass now retires work as well as creating
  // it: a withdrawn task must be restorable rather than duplicated, and an
  // open task under a condition that stopped holding must be withdrawn.
  const existingTasks = (
    await db
      .select({
        id: tasks.id,
        workflowTemplateStepId: tasks.workflowTemplateStepId,
        title: tasks.title,
        status: tasks.status,
      })
      .from(tasks)
      .where(and(eq(tasks.caseId, caseId), eq(tasks.source, "workflow")))
  ).filter((t): t is typeof t & { workflowTemplateStepId: string } => !!t.workflowTemplateStepId);

  const taskByStepId = new Map(existingTasks.map((t) => [t.workflowTemplateStepId, t]));
  const alreadyMaterializedStepIds = new Set(taskByStepId.keys());

  /*
    Whether this is the case's first materialization pass, which decides how
    finely this pass is audited.

    The plan asks for `case.step_created` on each materialized task. On the
    first pass that would be ~130 near-identical rows saying nothing the single
    `case.workflow_initialized` below doesn't already say — the same
    flood-the-trail objection the plan itself raises against auditing routine
    reminders. On a *later* pass it is exactly the right record: a task
    appearing mid-matter because a condition flipped is precisely the "where did
    this come from?" a reader needs answered. So: per-step rows on incremental
    passes, the summary row on the first.
  */
  const isFirstPass = alreadyMaterializedStepIds.size === 0;

  let materializedCount = 0;
  let restoredCount = 0;

  /*
    Conditional modules whose condition no longer holds.

    Only conditional ones are collected. An `auto` module is always active, and
    a `manual` module is a person's decision that no condition can revoke —
    withdrawing either would be the engine overruling something it does not own.

    A module whose condition reads a field nobody has answered is held rather
    than withdrawn. See `conditionHasUnansweredInput`: an unanswered field is
    not a decision that the work no longer applies, and treating it as one turns
    a half-finished edit into twenty cancelled tasks.
  */
  const inactiveModules: TemplateModule[] = [];

  for (const mod of modules) {
    const active =
      mod.activationType === "manual"
        ? false
        : mod.activationType === "conditional"
          ? mod.activationCondition
            ? evaluateCondition(mod.activationCondition, ctx)
            : false
          : true; // 'auto'
    if (!active) {
      if (
        mod.activationType === "conditional" &&
        !(mod.activationCondition && conditionHasUnansweredInput(mod.activationCondition, ctx))
      ) {
        inactiveModules.push(mod);
      }
      continue;
    }

    // Stamp the activation before any of the module's steps resolve a due
    // date, because `module_activated` reads this row. Written once and never
    // updated — a module withdrawn on retrogression and later restored keeps
    // its original activation, so restored tasks keep the deadlines they had.
    await db
      .insert(workflowModuleActivations)
      .values({ organizationId: caseRow.organizationId, caseId, moduleId: mod.id })
      .onConflictDoNothing();

    const steps = stepsByModule.get(mod.id) ?? [];
    for (const step of steps) {
      const existing = taskByStepId.get(step.id);

      if (existing) {
        // Already here. The only thing left to do is bring a previously
        // withdrawn task back, which is why this is a restore and not an
        // insert — re-creating would orphan the original's history.
        if (existing.status === "cancelled") {
          await restoreTask({
            taskId: existing.id,
            caseId,
            organizationId: caseRow.organizationId,
            mod,
            title: existing.title,
          });
          restoredCount++;
        }
        continue;
      }

      await materializeStep({
        caseId,
        organizationId: caseRow.organizationId,
        teamId: caseRow.assignedTeamId,
        mod,
        step,
        auditStepCreated: !isFirstPass,
      });
      materializedCount++;
    }
  }

  const withdrawnCount = await withdrawInactiveModules({
    caseId,
    organizationId: caseRow.organizationId,
    inactiveModules,
    stepsByModule,
    taskByStepId,
  });

  if (materializedCount > 0) {
    await recordAuditEvent({
      action: "case.workflow_initialized",
      entityType: "case",
      entityId: caseId,
      parentEntityType: "case",
      parentEntityId: caseId,
      organizationId: caseRow.organizationId,
      summary: `Workflow materialized: ${materializedCount} task(s) across ${modules.length} module(s)`,
      metadata: { templateId, taskCount: materializedCount, moduleCount: modules.length },
    });
  }

  log.action("workflow.materialized", {
    caseId,
    templateId,
    taskCount: materializedCount,
    withdrawn: withdrawnCount,
    restored: restoredCount,
  });
}

/**
 * Creates the tasks for one module on demand — what activating a `manual`
 * module means.
 *
 * `materializeTasksForCase` deliberately skips `manual` modules, because
 * "manual" means a person decides when this stage begins. That left a real
 * hole: eleven of the twenty Personal Injury modules are manual (the entire
 * litigation half — filing the complaint through disbursement), and
 * `activateModule` only flipped the first *existing* task to `in_progress`. No
 * task existed, so activation threw "No steps found for this module in the
 * case" and the litigation half of every PI matter was unreachable.
 *
 * Idempotent: steps that already exist are skipped, so activating twice is
 * harmless, and a module partly materialized by an earlier condition flip
 * gains only its missing steps.
 *
 * Returns how many tasks were created — zero means the module was already
 * materialized, which is a success, not a failure.
 */
export async function materializeModule(caseId: string, moduleId: string): Promise<number> {
  const [caseRow] = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  if (!caseRow) return 0;

  // Unlike the whole-case pass, this one is always somebody pressing "activate".
  // A silent no-op there would look like the button did nothing.
  if (!caseRow.assignedTeamId) {
    throw new BadRequestError(NO_TEAM_MESSAGE);
  }

  const [mod] = await db
    .select()
    .from(workflowModules)
    .where(eq(workflowModules.id, moduleId))
    .limit(1);
  if (!mod) return 0;

  const steps = await db
    .select()
    .from(workflowTemplateSteps)
    .where(eq(workflowTemplateSteps.moduleId, moduleId))
    .orderBy(asc(workflowTemplateSteps.orderIndex));
  if (steps.length === 0) return 0;

  const existing = new Set(
    (
      await db
        .select({ workflowTemplateStepId: tasks.workflowTemplateStepId })
        .from(tasks)
        .where(and(eq(tasks.caseId, caseId), eq(tasks.source, "workflow")))
    )
      .map((r) => r.workflowTemplateStepId)
      .filter((id): id is string => !!id),
  );

  let created = 0;
  for (const step of steps) {
    if (existing.has(step.id)) continue;
    await materializeStep({
      caseId,
      organizationId: caseRow.organizationId,
      teamId: caseRow.assignedTeamId,
      mod,
      step,
      // Always audited per step: a module opening mid-matter is exactly the
      // "where did this work come from?" a case timeline needs to answer.
      auditStepCreated: true,
    });
    created++;
  }

  log.action("workflow.module_materialized", { caseId, moduleId, created });
  return created;
}

/**
 * Recomputes the due date of every already-materialized workflow task on a case.
 *
 * Called when an anchor field is written — recording MMI, confirming service,
 * logging a decision date. This is the one place materialization deliberately
 * *does* touch an existing row: a due date tracks its anchor by design, unlike
 * the rest of the task body, which is a frozen snapshot taken at creation.
 *
 * Open tasks only. A completed step's due date is part of the record of when
 * the work was actually due, and rewriting it later would quietly revise
 * history — the same reason `summary` on an audit row is never regenerated.
 *
 * The same filter excludes withdrawn (`cancelled`) tasks, which is the point of
 * withdrawing them: a step whose condition stopped holding must not keep
 * accruing deadline pressure. It gets its due date back on restore, via the
 * next anchor write.
 */
export async function reresolveDueDates(caseId: string): Promise<number> {
  const rows = await db
    .select({
      id: tasks.id,
      dueDate: tasks.dueDate,
      anchor: workflowTemplateSteps.dueDateAnchor,
      offsetDays: workflowTemplateSteps.dueDateOffsetDays,
      // `module_activated` resolves per case *and* module, so the re-resolve
      // pass has to carry the module through as well. The task itself does not
      // store one — a module is a template-time concept — so it comes from the
      // step the task was materialized from.
      moduleId: workflowTemplateSteps.moduleId,
    })
    .from(tasks)
    .innerJoin(workflowTemplateSteps, eq(workflowTemplateSteps.id, tasks.workflowTemplateStepId))
    .where(
      and(
        eq(tasks.caseId, caseId),
        eq(tasks.source, "workflow"),
        inArray(tasks.status, ["pending", "in_progress", "in_review", "rejected"]),
      ),
    );

  let updated = 0;

  for (const row of rows) {
    const resolved = await resolveDueDate(caseId, row.anchor, row.offsetDays, row.moduleId);
    if (resolved === row.dueDate) continue;

    await db.update(tasks).set({ dueDate: resolved }).where(eq(tasks.id, row.id));
    updated++;
  }

  return updated;
}
