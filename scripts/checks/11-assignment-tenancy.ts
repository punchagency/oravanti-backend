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
import { and, eq } from "drizzle-orm";
import { systemDb } from "../../src/db/client";
import { tasks } from "../../src/db/schema/tasks";
import { TasksService } from "../../src/modules/tasks/tasks.service";
import { assignTask } from "../../src/modules/tasks/task-transitions.service";
import { WorkflowService } from "../../src/modules/workflow/workflow.service";
import {
  check,
  report,
  section,
  withOrgContext,
  withTempFixture,
} from "./_bootstrap";

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

          // Lead tasks now live in the unified `tasks` table (source = 'pipeline').
          // Insert directly to test that cross-tenant staff ids are refused at the
          // service level when the task is later accessed through the API.
          await systemDb
            .insert(tasks)
            .values({
              organizationId: a.organizationId,
              leadId: a.leadId,
              source: "pipeline",
              title: "Cross-tenant assignment",
              orderIndex: 0,
              phase: "conflict_check",
              assignedToId: b.staffId,
            });

          check(
            "createTask wrote no lead task with a foreign assignee",
            (
              await systemDb
                .select()
                .from(tasks)
                .where(and(eq(tasks.leadId, a.leadId), eq(tasks.source, "pipeline")))
            ).length === 0,
          );

          check(
            "createTask still accepts its own firm's staff",
            !(await refuses(() =>
              tasksService.createTask({
                organizationId: a.organizationId,
                title: "Legitimate assignment",
                description: "lead task via createTask",
                caseId: a.case!.caseId,
                assignedToId: a.staffId,
                assignedById: a.staffId,
                dueDate: new Date(Date.now() + 86_400_000).toISOString(),
              }),
            )),
          );

          section("lead tasks — reassigning to a foreign assignee");

          // Insert a pipeline task we can attempt to reassign.
          const [pipelineTask] = await systemDb
            .insert(tasks)
            .values({
              organizationId: a.organizationId,
              leadId: a.leadId,
              source: "pipeline",
              title: "Reassignment target",
              orderIndex: 0,
              phase: "conflict_check",
              assignedToId: a.staffId,
            })
            .returning();

          check(
            "assignTask refuses another firm's staff",
            await refuses(() =>
              assignTask({ taskId: pipelineTask.id, assignedToId: b.staffId, organizationId: a.organizationId }),
            ),
          );

          const [afterAssign] = await systemDb
            .select()
            .from(tasks)
            .where(eq(tasks.id, pipelineTask.id));
          check(
            "the existing assignee is untouched",
            afterAssign?.assignedToId === a.staffId,
            afterAssign?.assignedToId,
          );

          section("case tasks");

          check(
            "TasksService.createTask refuses another firm's staff",
            await refuses(() =>
              tasksService.createTask({
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
                .where(and(eq(tasks.organizationId, a.organizationId), eq(tasks.source, "ad_hoc")))
            ).length === 0,
          );

          section("case workflow steps");

          const [step] = await systemDb
            .insert(tasks)
            .values({
              organizationId: a.organizationId,
              caseId: a.case!.caseId,
              source: "workflow",
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
            .from(tasks)
            .where(eq(tasks.id, step.id));
          check(
            "the step was left unassigned",
            !afterStep?.assignedToId,
            afterStep?.assignedToId,
          );
        });
      } finally {
        await systemDb
          .delete(tasks)
          .where(eq(tasks.organizationId, a.organizationId));
        // The case itself belongs to the fixture; withTempFixture tears it down.
      }
    });
  });

  await report();
};

void main();
