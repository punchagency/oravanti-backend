/**
 * Tier 1 — Postgres. Assignment paths must not accept another firm's staff.
 *
 *   npm run check 11-assignment-tenancy
 *
 * Every assignment column references `staff.id` with no organization in the
 * foreign key, and `staff` carries no RLS policy — so the database happily
 * accepts an id belonging to another firm. Each of these four paths used to do
 * exactly that: `WorkflowService.assignStep` looked staff up without an org
 * filter, and the other three did not look at all.
 *
 * Two fixtures means two organizations; the test is always "org A's endpoint,
 * org B's staff id".
 */
import { eq } from "drizzle-orm";
import { systemDb } from "../../src/db/client";
import { leadTasks } from "../../src/db/schema/lead-tasks";
import { tasks } from "../../src/db/schema/tasks";
import { caseWorkflowSteps } from "../../src/db/schema/workflow";
import { LeadWorkflowService } from "../../src/modules/leads/lead-workflow.service";
import { TasksService } from "../../src/modules/tasks/tasks.service";
import { WorkflowService } from "../../src/modules/workflow/workflow.service";
import {
  check,
  report,
  section,
  withOrgContext,
  withTempFixture,
} from "./_bootstrap";

const leadWorkflow = new LeadWorkflowService();
const tasksService = new TasksService();
const workflow = new WorkflowService();

/** Run `fn`, reporting whether it refused. */
const refuses = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

const main = async () => {
  // Org A owns the records; org B only ever lends a staff id.
  await withTempFixture({ docs: [], withCase: true }, async (a) => {
    await withTempFixture({ docs: [] }, async (b) => {
      try {
        await withOrgContext(a.organizationId, a.userId, async () => {
          section("lead tasks — creating with a foreign assignee");

          check(
            "createTask refuses another firm's staff",
            await refuses(() =>
              leadWorkflow.createTask(
                {
                  leadId: a.leadId,
                  title: "Cross-tenant assignment",
                  orderIndex: 0,
                  pipelineStage: "conflict_check",
                  assignedToId: b.staffId,
                },
                a.organizationId,
              ),
            ),
          );
          check(
            "and wrote no task",
            (
              await systemDb
                .select()
                .from(leadTasks)
                .where(eq(leadTasks.leadId, a.leadId))
            ).length === 0,
          );

          check(
            "createTask still accepts its own firm's staff",
            !(await refuses(() =>
              leadWorkflow.createTask(
                {
                  leadId: a.leadId,
                  title: "Legitimate assignment",
                  orderIndex: 0,
                  pipelineStage: "conflict_check",
                  assignedToId: a.staffId,
                },
                a.organizationId,
              ),
            )),
          );

          section("lead tasks — reassigning to a foreign assignee");

          const [task] = await systemDb
            .select()
            .from(leadTasks)
            .where(eq(leadTasks.leadId, a.leadId));

          check(
            "assignTask refuses another firm's staff",
            await refuses(() =>
              leadWorkflow.assignTask(task.id, b.staffId, a.organizationId),
            ),
          );

          const [afterAssign] = await systemDb
            .select()
            .from(leadTasks)
            .where(eq(leadTasks.id, task.id));
          check(
            "the existing assignee is untouched",
            afterAssign?.assignedToId === a.staffId,
            afterAssign?.assignedToId,
          );

          section("case tasks");

          check(
            "TasksService.create refuses another firm's staff",
            await refuses(() =>
              tasksService.create({
                organizationId: a.organizationId,
                title: "Cross-tenant task",
                description: "should not exist",
                caseId: a.case!.caseId,
                assignedToId: b.staffId,
                assignedById: a.staffId,
                dueDate: new Date(Date.now() + 86_400_000).toISOString(),
              }),
            ),
          );
          check(
            "and wrote no task",
            (
              await systemDb
                .select()
                .from(tasks)
                .where(eq(tasks.organizationId, a.organizationId))
            ).length === 0,
          );

          section("case workflow steps");

          const [step] = await systemDb
            .insert(caseWorkflowSteps)
            .values({
              organizationId: a.organizationId,
              caseId: a.case!.caseId,
              title: "Check step",
              orderIndex: 0,
            })
            .returning();

          check(
            "assignStep refuses another firm's staff",
            await refuses(() =>
              workflow.assignStep(
                a.case!.caseId,
                step.id,
                b.staffId,
                a.organizationId,
              ),
            ),
          );

          const [afterStep] = await systemDb
            .select()
            .from(caseWorkflowSteps)
            .where(eq(caseWorkflowSteps.id, step.id));
          check(
            "the step was left unassigned",
            !afterStep?.assignedToId,
            afterStep?.assignedToId,
          );
        });
      } finally {
        await systemDb
          .delete(caseWorkflowSteps)
          .where(eq(caseWorkflowSteps.organizationId, a.organizationId));
        await systemDb
          .delete(tasks)
          .where(eq(tasks.organizationId, a.organizationId));
        await systemDb
          .delete(leadTasks)
          .where(eq(leadTasks.organizationId, a.organizationId));
        // The case itself belongs to the fixture; withTempFixture tears it down.
      }
    });
  });

  await report();
};

void main();
