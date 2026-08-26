import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/*
  Recording a milestone writes three places, and the whole design rests on it
  writing all three or none.

  `case_milestones` is the source of truth, `immigration_case_details.<date>` is
  a denormalized projection so the due-date resolver stays a single-row lookup,
  and `calendar_events` carries the two that are real appointments. That
  redundancy is only safe because exactly one function writes all three — the
  projection columns are deliberately excluded from `ImmigrationDetailsPatch` so
  nothing else can reach them.

  These tests pin the properties that make it safe: one transaction, the right
  projection column, a calendar entry for appointments only, the correction path
  writing a different audit action, and the due-date re-resolution that is the
  point of the whole exercise.
*/

// ── Mocks, declared before the module under test is imported ───────────────

const tx = {
  insert: jest.fn(),
  update: jest.fn(),
  select: jest.fn(),
};

const mockDb = {
  select: jest.fn(),
  transaction: jest.fn(),
};

const recordAuditEvent = jest.fn<(...args: any[]) => Promise<void>>();
const reresolveDueDates = jest.fn<(...args: any[]) => Promise<number>>();

jest.mock("../../../src/db/client", () => ({ db: mockDb }));
jest.mock("../../../src/modules/shared/audit.service", () => ({ recordAuditEvent }));
jest.mock("../../../src/modules/workflow/task-materialization.service", () => ({
  reresolveDueDates,
  materializeTasksForCase: jest.fn(),
}));

/** A `select().from().where().limit()` chain resolving to `rows`. */
const selectChain = (rows: unknown[]) => {
  const chain: any = {
    from: jest.fn(() => chain),
    where: jest.fn(() => chain),
    limit: jest.fn(() => Promise.resolve(rows)),
    orderBy: jest.fn(() => Promise.resolve(rows)),
  };
  return chain;
};

/** Captures what `.set()` / `.values()` were called with, per table. */
const writes = {
  updated: [] as { table: string; values: Record<string, unknown> }[],
  inserted: [] as { table: string; values: Record<string, unknown> }[],
};

const tableNameOf = (table: any): string =>
  table?.[Symbol.for("drizzle:Name")] ?? table?._?.name ?? "unknown";

const updateChain = (table: any, returning: unknown[]) => {
  const chain: any = {
    set: jest.fn((values: Record<string, unknown>) => {
      writes.updated.push({ table: tableNameOf(table), values });
      return chain;
    }),
    where: jest.fn(() => chain),
    returning: jest.fn(() => Promise.resolve(returning)),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  };
  return chain;
};

const insertChain = (table: any, returning: unknown[]) => {
  const chain: any = {
    values: jest.fn((values: Record<string, unknown>) => {
      writes.inserted.push({ table: tableNameOf(table), values });
      return chain;
    }),
    returning: jest.fn(() => Promise.resolve(returning)),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
  };
  return chain;
};

const CASE = { id: "case-1", caseNumber: "2026-AOS-001" };
const ORG = "firm-1";

/**
 * Wires the mocks for one call.
 *
 * `existingMilestone` drives the record-vs-correct branch; `existingEvent`
 * drives whether the calendar entry is created or moved.
 */
function arrange(opts: { existingMilestone?: { id: string; occurredOn: string }; existingEvent?: boolean } = {}) {
  writes.updated = [];
  writes.inserted = [];

  const savedRow = { id: "milestone-1" };

  // Two top-level selects, in order: the case, then any existing milestone.
  mockDb.select
    .mockReturnValueOnce(selectChain([CASE]))
    .mockReturnValueOnce(selectChain(opts.existingMilestone ? [opts.existingMilestone] : []));

  mockDb.transaction.mockImplementation(async (fn: any) => {
    tx.select.mockReturnValue(selectChain(opts.existingEvent ? [{ id: "event-1" }] : []));
    tx.update.mockImplementation((table: any) => updateChain(table, [savedRow]));
    tx.insert.mockImplementation((table: any) => insertChain(table, [savedRow]));
    return fn(tx);
  });

  reresolveDueDates.mockResolvedValue(4);
}

const record = async (params: Record<string, unknown>) => {
  const { recordCaseMilestone } = await import(
    "../../../src/modules/workflow/case-milestone.service"
  );
  return recordCaseMilestone({
    caseId: CASE.id,
    organizationId: ORG,
    actorStaffId: "staff-1",
    ...params,
  } as any);
};

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.transaction.mockReset();
  tx.insert.mockReset();
  tx.update.mockReset();
  tx.select.mockReset();
  recordAuditEvent.mockReset();
  reresolveDueDates.mockReset();
});

describe("recording a milestone writes all three layers", () => {
  it("does every write inside one transaction", async () => {
    // A projection that disagrees with its milestone row is the exact failure
    // this design exists to prevent, so partial success must be impossible.
    arrange();
    await record({ milestone: "receipt", occurredOn: "2026-03-01" });

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
  });

  it("inserts the milestone row and writes its projection column", async () => {
    arrange();
    await record({ milestone: "receipt", occurredOn: "2026-03-01", noticeNumber: "MSC2190" });

    expect(writes.inserted.some((w) => w.table === "case_milestones")).toBe(true);

    const projection = writes.updated.find((w) => w.table === "immigration_case_details");
    expect(projection?.values.receiptDate).toBe("2026-03-01");
  });

  it("writes the column that matches the milestone, not a fixed one", async () => {
    // One entry per enum value. A milestone landing in the wrong column would
    // move the wrong tasks' deadlines and nothing would look broken.
    const cases: [string, string][] = [
      ["receipt", "receiptDate"],
      ["biometrics_appointment", "biometricsAppointmentDate"],
      ["interview_scheduled", "interviewScheduledDate"],
      ["decision", "decisionDate"],
      ["card_valid_to", "cardValidTo"],
      ["green_card_expiration", "greenCardExpirationDate"],
    ];

    for (const [milestone, column] of cases) {
      arrange();
      await record({ milestone, occurredOn: "2026-03-01" });

      const projection = writes.updated.find((w) => w.table === "immigration_case_details");
      expect(projection?.values[column]).toBe("2026-03-01");
    }
  });

  it("re-resolves the case's due dates, which is the point of the exercise", async () => {
    // Sixteen of the AOS template's steps anchor on these six dates. Until one
    // is recorded they all render as "due once recorded".
    arrange();
    await record({ milestone: "receipt", occurredOn: "2026-03-01" });

    expect(reresolveDueDates).toHaveBeenCalledWith(CASE.id);
  });
});

describe("the calendar entry", () => {
  it("is created for an appointment milestone", async () => {
    arrange();
    await record({ milestone: "biometrics_appointment", occurredOn: "2026-04-10" });

    expect(writes.inserted.some((w) => w.table === "calendar_events")).toBe(true);
  });

  it("is moved rather than duplicated when the appointment is rescheduled", async () => {
    // USCIS moves appointments routinely. A second event each time would leave a
    // trail of stale entries on a calendar someone actually reads.
    arrange({ existingEvent: true });
    await record({ milestone: "interview_scheduled", occurredOn: "2026-07-01" });

    expect(writes.inserted.some((w) => w.table === "calendar_events")).toBe(false);
    expect(writes.updated.some((w) => w.table === "calendar_events")).toBe(true);
  });

  it("is not created for a date that is merely printed on a notice", async () => {
    // A receipt date is not an appointment. Putting these on a calendar would
    // bury the two entries that are.
    arrange();
    await record({ milestone: "receipt", occurredOn: "2026-03-01" });

    expect(writes.inserted.some((w) => w.table === "calendar_events")).toBe(false);
    expect(writes.updated.some((w) => w.table === "calendar_events")).toBe(false);
  });
});

describe("the audit trail distinguishes a correction from a first record", () => {
  it("writes case.milestone_recorded the first time", async () => {
    arrange();
    await record({ milestone: "receipt", occurredOn: "2026-03-01" });

    const event = recordAuditEvent.mock.calls[0][0] as any;
    expect(event.action).toBe("case.milestone_recorded");
    expect(event.summary).toContain("2026-03-01");
  });

  it("writes case.milestone_corrected when the date changes, keeping the old one", async () => {
    // The old date is what makes a correction reviewable years later, so it goes
    // in both the summary and the metadata.
    arrange({ existingMilestone: { id: "m-1", occurredOn: "2026-06-20" } });
    await record({ milestone: "interview_scheduled", occurredOn: "2026-07-01" });

    const event = recordAuditEvent.mock.calls[0][0] as any;
    expect(event.action).toBe("case.milestone_corrected");
    expect(event.summary).toContain("2026-06-20");
    expect(event.summary).toContain("2026-07-01");
    expect(event.metadata.previousOccurredOn).toBe("2026-06-20");
  });

  it("updates the existing row in place rather than adding a second one", async () => {
    arrange({ existingMilestone: { id: "m-1", occurredOn: "2026-06-20" } });
    await record({ milestone: "interview_scheduled", occurredOn: "2026-07-01" });

    expect(writes.inserted.some((w) => w.table === "case_milestones")).toBe(false);
    expect(writes.updated.some((w) => w.table === "case_milestones")).toBe(true);
  });

  it("does not call it a correction when the same date is re-recorded", async () => {
    // Re-entering the same date is a no-op in substance; logging it as a
    // correction would put noise in the one record that must stay readable.
    arrange({ existingMilestone: { id: "m-1", occurredOn: "2026-03-01" } });
    await record({ milestone: "receipt", occurredOn: "2026-03-01" });

    expect((recordAuditEvent.mock.calls[0][0] as any).action).toBe("case.milestone_recorded");
  });
});
