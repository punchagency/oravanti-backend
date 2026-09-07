import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { getTableName } from "drizzle-orm";

/*
  The lead attorney's review of a filing package.

  What is being pinned here is not the CRUD — it is the four rules that make the
  review mean anything, each of which is a rule about something that must NOT be
  possible:

  - a package cannot be approved while a correction is open;
  - a form cannot be marked ready to file until the package is approved;
  - an approval does not survive a correction being reopened;
  - a mark that anchors to nothing, or to two things, is refused.

  Each of those is one `if` in the service, and each of them fails silently if it
  goes: the screen still works, the package still files, and the only sign is a
  filing that went to USCIS with something the attorney said was wrong.
*/

const mockDb = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  transaction: jest.fn(),
};

const recordAuditEvent = jest.fn<(...args: any[]) => Promise<void>>();
const isActorAnAttorney = jest.fn<(id: unknown) => Promise<boolean>>();
const getRequestContext = jest.fn<() => Record<string, unknown>>();

jest.mock("../../../src/db/client", () => ({ db: mockDb }));
jest.mock("../../../src/modules/shared/audit.service", () => ({
  recordAuditEvent,
}));
jest.mock("../../../src/modules/case-review/assignees", () => ({
  isActorAnAttorney,
}));
jest.mock("../../../src/middleware/request-context", () => ({
  getRequestContext,
}));

const ORG = "firm-1";
const CASE_ID = "case-1";
const ATTORNEY = "staff-attorney";

const caseRow = (over: Record<string, unknown> = {}) => ({
  id: CASE_ID,
  caseNumber: "2026-I4AO-001",
  filingReviewStatus: "in_review",
  filingApprovedById: null,
  filingApprovedAt: null,
  ...over,
});

const correction = (over: Record<string, unknown> = {}) => ({
  id: "corr-1",
  caseId: CASE_ID,
  status: "resolved",
  partLabel: null,
  fieldKey: "beneficiary.family_name",
  formCode: "I-485",
  ...over,
});

/** What each table answers, and what the run wrote. */
let updates: { table: string; values: Record<string, unknown> }[] = [];
let inserts: { table: string; values: Record<string, unknown> }[] = [];

/**
 * Arranges the reads by table rather than by call order.
 *
 * The service interleaves three tables — the matter, the corrections, the forms
 * — differently depending on which entry point a test uses, so a positional
 * queue would make every test here depend on the order of queries inside a
 * function that is about something else. `rows.corrections` is a queue because
 * one call genuinely asks twice: `openCorrectionCount` counts, then the caller
 * reads.
 */
function arrange(rows: {
  cases?: unknown[];
  case_forms?: unknown[];
  case_form_corrections?: unknown[][];
  staff?: unknown[];
}) {
  updates = [];
  inserts = [];
  recordAuditEvent.mockReset();
  isActorAnAttorney.mockReset().mockResolvedValue(true);
  getRequestContext.mockReset().mockReturnValue({
    staffId: ATTORNEY,
    organizationId: ORG,
  });

  const corrections = [...(rows.case_form_corrections ?? [[]])];

  mockDb.select.mockImplementation(() => {
    let answer: unknown[] = [];
    const chain: any = {
      from: jest.fn((table: any) => {
        const name = getTableName(table);
        if (name === "cases") answer = rows.cases ?? [caseRow()];
        else if (name === "case_forms")
          answer = rows.case_forms ?? [{ id: "form-1", formCode: "I-485" }];
        else if (name === "case_form_corrections")
          answer =
            corrections.length > 1 ? corrections.shift()! : corrections[0];
        else if (name === "staff") answer = rows.staff ?? [];
        else answer = [];
        return chain;
      }),
      innerJoin: jest.fn(() => chain),
      leftJoin: jest.fn(() => chain),
      where: jest.fn(() => chain),
      limit: jest.fn(() => Promise.resolve(answer)),
      orderBy: jest.fn(() => Promise.resolve(answer)),
      then: (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res),
    };
    return chain;
  });

  const writer = () => ({
    update: jest.fn((table: any) => {
      const chain: any = {
        set: jest.fn((values: Record<string, unknown>) => {
          updates.push({ table: getTableName(table), values });
          return chain;
        }),
        where: jest.fn(() => Promise.resolve(undefined)),
      };
      return chain;
    }),
    insert: jest.fn((table: any) => ({
      values: jest.fn((values: Record<string, unknown>) => {
        inserts.push({ table: getTableName(table), values });
        return {
          returning: () => Promise.resolve([{ id: "corr-new", ...values }]),
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve(undefined).then(res),
        };
      }),
    })),
  });

  const w = writer();
  mockDb.update.mockImplementation(w.update);
  mockDb.insert.mockImplementation(w.insert);
  mockDb.transaction.mockImplementation((run: any) => run(w));
}

const svc = () => import("../../../src/modules/workflow/form-review.service");

/** The last write to `cases`, which is where the review's state lives. */
const reviewStatus = () =>
  updates.filter((u) => u.table === "cases").at(-1)?.values;

beforeEach(() => {
  jest.resetModules();
});

describe("approving the package", () => {
  it("is refused while a correction is open, and says how many", async () => {
    arrange({ case_form_corrections: [[{ n: 2 }]] });

    await expect((await svc()).approveFiling(CASE_ID, ORG)).rejects.toThrow(
      /2 corrections are still open/i,
    );
    expect(reviewStatus()).toBeUndefined();
  });

  it("stamps who approved it and when", async () => {
    arrange({ case_form_corrections: [[{ n: 0 }]] });

    await (await svc()).approveFiling(CASE_ID, ORG);

    expect(reviewStatus()).toMatchObject({
      filingReviewStatus: "approved",
      filingApprovedById: ATTORNEY,
    });
    expect(reviewStatus()?.filingApprovedAt).toBeInstanceOf(Date);
  });

  it("is refused to anybody who is not an attorney", async () => {
    arrange({ case_form_corrections: [[{ n: 0 }]] });
    isActorAnAttorney.mockResolvedValue(false);

    await expect((await svc()).approveFiling(CASE_ID, ORG)).rejects.toThrow(
      /only an attorney/i,
    );
  });
});

describe("raising a correction", () => {
  const mark = {
    caseId: CASE_ID,
    organizationId: ORG,
    caseFormId: "form-1",
    note: "Name does not match the passport.",
  };

  it("puts the package into changes_requested", async () => {
    arrange({});

    await (
      await svc()
    ).raiseCorrection({
      ...mark,
      fieldKey: "beneficiary.family_name",
    });

    expect(reviewStatus()).toMatchObject({
      filingReviewStatus: "changes_requested",
    });
  });

  it("refuses a mark anchored to nothing", async () => {
    arrange({});

    await expect((await svc()).raiseCorrection(mark)).rejects.toThrow(
      /either one part of the form or one field/i,
    );
  });

  it("refuses a mark anchored to both a part and a field", async () => {
    arrange({});

    await expect(
      (await svc()).raiseCorrection({
        ...mark,
        partLabel: "Part 1. Information About You",
        fieldKey: "beneficiary.family_name",
      }),
    ).rejects.toThrow(/not both/i);
  });

  it("is refused to anybody who is not an attorney", async () => {
    arrange({});
    isActorAnAttorney.mockResolvedValue(false);

    await expect(
      (await svc()).raiseCorrection({ ...mark, partLabel: "Part 1." }),
    ).rejects.toThrow(/only an attorney/i);
  });
});

describe("answering a correction", () => {
  it("records what was changed as part of resolving it", async () => {
    arrange({ case_form_corrections: [[correction({ status: "open" })]] });

    await (
      await svc()
    ).resolveCorrection({
      correctionId: "corr-1",
      organizationId: ORG,
      note: "Corrected to Ruiz from the passport bio page.",
    });

    expect(inserts).toContainEqual(
      expect.objectContaining({
        table: "case_form_correction_comments",
        values: expect.objectContaining({
          body: "Corrected to Ruiz from the passport bio page.",
        }),
      }),
    );
    expect(
      updates.find((u) => u.table === "case_form_corrections")?.values,
    ).toMatchObject({ status: "resolved", resolvedById: ATTORNEY });
  });

  it("can be done by somebody who is not an attorney", async () => {
    arrange({ case_form_corrections: [[correction({ status: "open" })]] });
    isActorAnAttorney.mockResolvedValue(false);

    await expect(
      (await svc()).resolveCorrection({
        correctionId: "corr-1",
        organizationId: ORG,
        note: "Fixed.",
      }),
    ).resolves.toMatchObject({ status: "resolved" });
  });
});

describe("reopening a correction", () => {
  it("spends the approval", async () => {
    arrange({
      cases: [caseRow({ filingReviewStatus: "approved" })],
      case_form_corrections: [[correction()]],
    });

    await (
      await svc()
    ).reopenCorrection({
      correctionId: "corr-1",
      organizationId: ORG,
      note: "Still the wrong spelling.",
    });

    expect(reviewStatus()).toMatchObject({
      filingReviewStatus: "changes_requested",
      filingApprovedById: null,
      filingApprovedAt: null,
    });
  });

  it("is refused to anybody who is not an attorney", async () => {
    arrange({ case_form_corrections: [[correction()]] });
    isActorAnAttorney.mockResolvedValue(false);

    await expect(
      (await svc()).reopenCorrection({
        correctionId: "corr-1",
        organizationId: ORG,
        note: "No.",
      }),
    ).rejects.toThrow(/only an attorney/i);
  });
});

describe("the gate on ready_to_file", () => {
  it("lets an approved package through", async () => {
    arrange({ cases: [caseRow({ filingReviewStatus: "approved" })] });

    expect(await (await svc()).readyToFileRefusal(CASE_ID)).toBeNull();
  });

  it("names the open corrections when there are any", async () => {
    arrange({
      cases: [caseRow({ filingReviewStatus: "changes_requested" })],
      case_form_corrections: [[{ n: 1 }]],
    });

    expect(await (await svc()).readyToFileRefusal(CASE_ID)).toMatch(
      /1 correction open/i,
    );
  });

  it("refuses a package nobody has approved, even with nothing open", async () => {
    arrange({
      cases: [caseRow({ filingReviewStatus: "in_review" })],
      case_form_corrections: [[{ n: 0 }]],
    });

    expect(await (await svc()).readyToFileRefusal(CASE_ID)).toMatch(
      /not been approved/i,
    );
  });
});
