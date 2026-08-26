import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/*
  Withdrawal: what happens to tasks when the condition that created them stops
  holding.

  Materialization used to only ever insert. A condition turning true created a
  module's tasks; a condition turning false afterwards did nothing, so unticking
  "conditional residence" left the I-751 window on the board — two locked steps
  counting down against a card that is not conditional.

  Deleting them would be worse: a task carries an assignee, notes, a review
  thread and possibly a completion, and conditions flip false because of typos
  at least as often as because a fact changed. So the task is kept, marked
  `cancelled`, dropped from the live counts, and restored if the condition holds
  again.

  These tests pin the three properties that make that safe: finished work is
  never touched, the retirement is audited with its previous status, and a
  restore reuses the original row rather than creating a second one.
*/

const mockDb = {
  select: jest.fn(),
  update: jest.fn(),
  insert: jest.fn(),
};

const recordAuditEvent = jest.fn<(...args: any[]) => Promise<void>>();
const evaluateCondition = jest.fn<(...args: any[]) => boolean>();
const pickBestAssignee = jest.fn<(...args: any[]) => Promise<string | null>>();
const resolveWorkflowTemplateId = jest.fn<(...args: any[]) => Promise<string | null>>();
const buildConditionContext = jest.fn<(...args: any[]) => Promise<any>>();
const conditionHasUnansweredInput = jest.fn<(...args: any[]) => boolean>();
const resolveDueDate = jest.fn<(...args: any[]) => Promise<string | null>>();

jest.mock("../../../src/db/client", () => ({ db: mockDb }));
jest.mock("../../../src/modules/shared/audit.service", () => ({ recordAuditEvent }));
jest.mock("../../../src/modules/workflow/condition-evaluator", () => ({
  evaluateCondition,
  buildConditionContext,
  conditionHasUnansweredInput,
}));
jest.mock("../../../src/modules/workflow/assignment.service", () => ({ pickBestAssignee }));
jest.mock("../../../src/modules/workflow/workflow-template.service", () => ({
  resolveWorkflowTemplateId,
}));
jest.mock("../../../src/modules/workflow/due-date-resolver", () => ({ resolveDueDate }));

const CASE = {
  id: "case-1",
  organizationId: "firm-1",
  caseTypeId: "ct-1",
  assignedTeamId: "team-1",
};

/** The I-751 module and its two steps, which is the real-world shape of this. */
const MODULE = {
  id: "mod-i751",
  templateId: "tmpl-1",
  name: "I-751 Removal of Conditions",
  orderIndex: 10,
  activationType: "conditional",
  activationCondition: { field: "immigrationDetails.isConditionalResidence", op: "eq", value: true },
};

const templateStep = (id: string, title: string, orderIndex: number) => ({
  id,
  moduleId: "mod-i751",
  title,
  description: null,
  orderIndex,
  dueDateAnchor: "green_card_expiration_date",
  dueDateOffsetDays: orderIndex === 1 ? -90 : 0,
  isLocked: true,
  requiredCertifications: [],
  assignableRoles: [],
});

const STEPS = [
  templateStep("step-1", "Begin I-751 preparation", 1),
  templateStep("step-2", "File I-751", 2),
];

/** Records every `.set()` the run performed, with the row it targeted. */
let updates: { values: Record<string, unknown> }[] = [];
let inserted: Record<string, unknown>[] = [];

/**
 * Wires one run.
 *
 * `existingTasks` is what is already on the board; `conditionHolds` drives the
 * withdraw-vs-restore branch.
 */
function arrange(opts: {
  conditionHolds: boolean;
  existingTasks: { id: string; workflowTemplateStepId: string; title: string; status: string }[];
  /** Whether a field the condition reads has no answer yet. Defaults to answered. */
  unanswered?: boolean;
  /** Overrides the shared steps — used to exercise the auto-assignment branch. */
  steps?: typeof STEPS;
}) {
  updates = [];
  inserted = [];

  evaluateCondition.mockReturnValue(opts.conditionHolds);
  conditionHasUnansweredInput.mockReturnValue(opts.unanswered ?? false);
  buildConditionContext.mockResolvedValue({});
  resolveWorkflowTemplateId.mockResolvedValue("tmpl-1");
  resolveDueDate.mockResolvedValue("2027-01-01");
  pickBestAssignee.mockResolvedValue(null);
  recordAuditEvent.mockReset();

  // The service issues four selects in order: the case, the modules, the
  // template steps, then the existing tasks.
  const queue: unknown[][] = [[CASE], [MODULE], opts.steps ?? STEPS, opts.existingTasks];
  let call = 0;

  mockDb.select.mockImplementation(() => {
    const rows = queue[Math.min(call++, queue.length - 1)];
    const chain: any = {
      from: jest.fn(() => chain),
      where: jest.fn(() => chain),
      limit: jest.fn(() => Promise.resolve(rows)),
      orderBy: jest.fn(() => Promise.resolve(rows)),
      innerJoin: jest.fn(() => chain),
      then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
    };
    return chain;
  });

  mockDb.update.mockImplementation(() => {
    const chain: any = {
      set: jest.fn((values: Record<string, unknown>) => {
        updates.push({ values });
        return chain;
      }),
      where: jest.fn(() => Promise.resolve(undefined)),
    };
    return chain;
  });

  mockDb.insert.mockImplementation(() => {
    const chain: any = {
      values: jest.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        return chain;
      }),
      returning: jest.fn(() => Promise.resolve([{ id: "new-task" }])),
    };
    return chain;
  });
}

const run = async () => {
  const { materializeTasksForCase } = await import(
    "../../../src/modules/workflow/task-materialization.service"
  );
  return materializeTasksForCase(CASE.id);
};

const task = (over: Partial<{ id: string; workflowTemplateStepId: string; title: string; status: string }>) => ({
  id: "task-1",
  workflowTemplateStepId: "step-1",
  title: "Begin I-751 preparation",
  status: "pending",
  ...over,
});

const actions = () => recordAuditEvent.mock.calls.map((c) => (c[0] as any).action);

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.update.mockReset();
  mockDb.insert.mockReset();
  evaluateCondition.mockReset();
  conditionHasUnansweredInput.mockReset();
});

describe("a condition that stops holding withdraws its open work", () => {
  it("cancels an open task rather than deleting it", async () => {
    arrange({ conditionHolds: false, existingTasks: [task({})] });
    await run();

    expect(updates).toHaveLength(1);
    expect(updates[0].values.status).toBe("cancelled");
  });

  it("withdraws a task someone is part-way through", async () => {
    // Deliberate: the work no longer applies, and leaving the board demanding
    // it is the defect. The audit row and the restore path make it safe.
    arrange({ conditionHolds: false, existingTasks: [task({ status: "in_progress" })] });
    await run();

    expect(updates[0].values.status).toBe("cancelled");
  });

  it("records case.step_withdrawn, naming the module and the previous status", async () => {
    arrange({ conditionHolds: false, existingTasks: [task({ status: "in_progress" })] });
    await run();

    const event = recordAuditEvent.mock.calls[0][0] as any;
    expect(event.action).toBe("case.step_withdrawn");
    expect(event.summary).toContain("I-751 Removal of Conditions");
    expect(event.metadata.previousStatus).toBe("in_progress");
  });

  it("withdraws every open step in the module, not just the first", async () => {
    arrange({
      conditionHolds: false,
      existingTasks: [
        task({ id: "task-1", workflowTemplateStepId: "step-1" }),
        task({ id: "task-2", workflowTemplateStepId: "step-2", title: "File I-751" }),
      ],
    });
    await run();

    expect(updates).toHaveLength(2);
  });
});

describe("finished work is never withdrawn", () => {
  // The condition turning false later does not make it untrue that the work was
  // done. Rewriting it would revise history.
  it.each(["completed", "skipped", "rejected"])("leaves a %s task alone", async (status) => {
    arrange({ conditionHolds: false, existingTasks: [task({ status })] });
    await run();

    expect(updates).toHaveLength(0);
    expect(actions()).not.toContain("case.step_withdrawn");
  });

  it("does not withdraw a task twice", async () => {
    // A second pass with the condition still false must be a no-op, or every
    // run would write another audit row for the same retirement.
    arrange({ conditionHolds: false, existingTasks: [task({ status: "cancelled" })] });
    await run();

    expect(updates).toHaveLength(0);
  });
});

describe("a condition that holds again restores what it withdrew", () => {
  it("returns the withdrawn task to pending", async () => {
    arrange({ conditionHolds: true, existingTasks: [task({ status: "cancelled" })] });
    await run();

    expect(updates).toHaveLength(1);
    expect(updates[0].values.status).toBe("pending");
  });

  it("reuses the original row instead of creating a second task", async () => {
    // The whole reason withdrawal is not deletion: the original carries the
    // notes, the assignee and the history. A fresh insert would orphan them.
    arrange({ conditionHolds: true, existingTasks: [task({ status: "cancelled" })] });
    await run();

    expect(inserted.some((v) => v.workflowTemplateStepId === "step-1")).toBe(false);
  });

  it("records case.step_restored", async () => {
    arrange({ conditionHolds: true, existingTasks: [task({ status: "cancelled" })] });
    await run();

    expect(actions()).toContain("case.step_restored");
  });

  it("leaves an already-open task untouched", async () => {
    // Restoring is only for withdrawn work. Resetting a live in-progress task
    // to pending on every pass would discard someone's state.
    arrange({ conditionHolds: true, existingTasks: [task({ status: "in_progress" })] });
    await run();

    expect(updates).toHaveLength(0);
  });
});

describe("an unanswered input holds the work rather than withdrawing it", () => {
  /*
    The distinction `evaluateCondition` cannot make on its own.

    "Sequential" and "nobody has picked a filing track yet" both evaluate false,
    and both should stop the I-485 package from *starting*. Only the first is a
    decision that the package no longer applies. Treating a half-finished edit
    as the second turns clearing a dropdown into twenty cancelled tasks and
    forty audit rows on the round trip.
  */
  it("does not withdraw when a field the condition reads has no answer", async () => {
    arrange({ conditionHolds: false, unanswered: true, existingTasks: [task({})] });
    await run();

    expect(updates).toHaveLength(0);
    expect(actions()).not.toContain("case.step_withdrawn");
  });

  it("still withdraws once the field has a positively-false answer", async () => {
    // The same condition, now decidable. Un-ticking is a person's decision and
    // withdrawal is exactly right for it.
    arrange({ conditionHolds: false, unanswered: false, existingTasks: [task({})] });
    await run();

    expect(updates[0]?.values.status).toBe("cancelled");
    expect(actions()).toContain("case.step_withdrawn");
  });

  it("does not hold work open when the condition holds", async () => {
    // Unanswered only ever suppresses withdrawal; it never blocks a restore.
    arrange({ conditionHolds: true, unanswered: true, existingTasks: [task({ status: "cancelled" })] });
    await run();

    expect(updates[0]?.values.status).toBe("pending");
    expect(actions()).toContain("case.step_restored");
  });
});

describe("assignment does not start the work", () => {
  /*
    Being given a task is not the same as beginning it. Materialization used to
    stamp `in_progress` the moment it auto-assigned, so a freshly opened matter
    showed every step underway, "in progress" carried no information, and
    auto-assignment behaved differently from a person assigning by hand
    (`reassignTask` has always left the status alone).
  */
  const assignableStep = { ...templateStep("step-1", "Begin I-751 preparation", 1), assignableRoles: ["paralegal"] };

  it("assigns the task without moving it out of pending", async () => {
    arrange({ conditionHolds: true, existingTasks: [], steps: [assignableStep] });
    pickBestAssignee.mockResolvedValue("staff-1");

    await run();

    expect(inserted[0]?.status).toBe("pending");

    const assignment = updates.find((u) => "assignedToId" in u.values);
    expect(assignment).toBeDefined();
    expect(assignment!.values.assignedToId).toBe("staff-1");
    // The whole point: the assignment write must not carry a status at all.
    expect(assignment!.values).not.toHaveProperty("status");
  });

  it("still creates the task pending when nobody on the team matches", async () => {
    arrange({ conditionHolds: true, existingTasks: [], steps: [assignableStep] });
    pickBestAssignee.mockResolvedValue(null);

    await run();

    expect(inserted[0]?.status).toBe("pending");
    expect(updates.find((u) => "assignedToId" in u.values)).toBeUndefined();
  });
});
