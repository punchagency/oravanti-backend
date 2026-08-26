import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/*
  Per-form tracking for a filing package.

  A concurrent adjustment filing is not one form. It is an I-130, I-485, I-765
  and I-131, plus an I-864 and I-693 riding along — six pieces of paper, each
  with its own edition, fee, receipt number and adjudication. Before this table
  the case record held a single `filing_type` enum and a `receipt_numbers` jsonb
  map, so nothing could answer "is the I-765 filed?", only "is the package
  filed?" — and the I-765 is exactly where it matters, because it is routinely
  approved months before the I-485 it accompanies.

  These tests pin the rules that are facts about USCIS rather than preferences:
  a receipt number implies receipt, a supporting document never has one, and a
  form that has reached the government is withdrawn rather than deleted.
*/

const mockDb = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const recordAuditEvent = jest.fn<(...args: any[]) => Promise<void>>();

/*
  Which package a matter files is the workflow template's answer, and
  `case-capabilities.service` is where that is derived and separately tested.
  Stubbed here so these tests stay about assembling a package rather than about
  resolving a template.
*/
type Profile = { adjustment: boolean; naturalization: boolean; mandamus: boolean };
const caseFilingProfile = jest.fn<(...args: any[]) => Promise<Profile>>();

jest.mock("../../../src/db/client", () => ({ db: mockDb }));
jest.mock("../../../src/modules/shared/audit.service", () => ({ recordAuditEvent }));
jest.mock("../../../src/modules/workflow/case-capabilities.service", () => ({ caseFilingProfile }));

const CASE = { id: "case-1", caseNumber: "2026-I4AO-001" };
const ORG = "firm-1";

let updated: Record<string, unknown>[] = [];
let inserted: Record<string, unknown>[] = [];
let deleted = 0;

const form = (over: Record<string, unknown> = {}) => ({
  id: "form-1",
  organizationId: ORG,
  caseId: CASE.id,
  formCode: "I-485",
  role: "core",
  status: "in_preparation",
  editionDate: null,
  filedDate: null,
  receiptNumber: null,
  feeCents: null,
  notes: null,
  ...over,
});

/** `selects` are consumed in call order: the case first, then whatever follows. */
function arrange(selects: unknown[][]) {
  updated = [];
  inserted = [];
  deleted = 0;
  recordAuditEvent.mockReset();

  const queue = [[CASE], ...selects];
  let call = 0;

  mockDb.select.mockImplementation(() => {
    const rows = queue[Math.min(call++, queue.length - 1)];
    const chain: any = {
      from: jest.fn(() => chain),
      where: jest.fn(() => chain),
      limit: jest.fn(() => Promise.resolve(rows)),
      orderBy: jest.fn(() => Promise.resolve(rows)),
      then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
    };
    return chain;
  });

  mockDb.update.mockImplementation(() => {
    const chain: any = {
      set: jest.fn((v: Record<string, unknown>) => {
        updated.push(v);
        return chain;
      }),
      where: jest.fn(() => chain),
      returning: jest.fn(() => Promise.resolve([form(updated[0])])),
    };
    return chain;
  });

  mockDb.insert.mockImplementation(() => ({
    values: jest.fn((v: Record<string, unknown>[]) => {
      inserted.push(...(Array.isArray(v) ? v : [v]));
      return Promise.resolve(undefined);
    }),
  }));

  mockDb.delete.mockImplementation(() => ({
    where: jest.fn(() => {
      deleted++;
      return Promise.resolve(undefined);
    }),
  }));
}

const svc = () => import("../../../src/modules/workflow/case-forms.service");

beforeEach(() => {
  mockDb.select.mockReset();
  mockDb.insert.mockReset();
  mockDb.update.mockReset();
  mockDb.delete.mockReset();
  caseFilingProfile.mockReset();
  caseFilingProfile.mockResolvedValue({
    adjustment: true,
    naturalization: false,
    mandamus: false,
  });
});

describe("the adjustment package", () => {
  it("is four core forms plus two supporting documents", async () => {
    // The distinction decides whether a receipt number is expected, so it is
    // part of the definition rather than a UI detail.
    const { ADJUSTMENT_PACKAGE } = await svc();

    expect(ADJUSTMENT_PACKAGE.filter((f) => f.role === "core").map((f) => f.formCode)).toStrictEqual([
      "I-130",
      "I-485",
      "I-765",
      "I-131",
    ]);
    expect(ADJUSTMENT_PACKAGE.filter((f) => f.role === "supporting").map((f) => f.formCode)).toStrictEqual([
      "I-864",
      "I-693",
    ]);
  });

  it("creates only the forms not already on the matter", async () => {
    // Additive on purpose: a form that has reached `receipted` must not be
    // reset to `not_started` by someone re-running setup.
    arrange([[{ formCode: "I-130" }, { formCode: "I-485" }]]);
    const { ensurePackageForms } = await svc();

    const created = await ensurePackageForms({ caseId: CASE.id, organizationId: ORG });

    expect(created).toBe(4);
    expect(inserted.map((f) => f.formCode)).toStrictEqual(["I-765", "I-131", "I-864", "I-693"]);
  });

  it("does nothing when the package is already set up", async () => {
    const all = ["I-130", "I-485", "I-765", "I-131", "I-864", "I-693"].map((formCode) => ({ formCode }));
    arrange([all]);
    const { ensurePackageForms } = await svc();

    expect(await ensurePackageForms({ caseId: CASE.id, organizationId: ORG })).toBe(0);
    expect(inserted).toHaveLength(0);
  });
});

describe("which package a matter files comes from its workflow", () => {
  /*
    This replaced a `filing_type` column someone had to pick a value for. The
    question it asked had no true answer — a concurrent filing is six forms —
    and every reader downstream inherited whichever one got chosen. The template
    already declares what kind of filing the matter is, so it answers instead.
  */
  it("gives a naturalization matter the N-400 alone", async () => {
    caseFilingProfile.mockResolvedValue({
      adjustment: false,
      naturalization: true,
      mandamus: false,
    });
    arrange([[]]);
    const { ensurePackageForms } = await svc();

    expect(await ensurePackageForms({ caseId: CASE.id, organizationId: ORG })).toBe(1);
    expect(inserted.map((f) => f.formCode)).toStrictEqual(["N-400"]);
  });

  it("gives a matter whose workflow files nothing an empty package", async () => {
    // Guessing here would put an I-864 on a matter with no sponsor. A firm
    // filing something non-standard names its own list instead.
    caseFilingProfile.mockResolvedValue({
      adjustment: false,
      naturalization: false,
      mandamus: true,
    });
    arrange([[]]);
    const { ensurePackageForms } = await svc();

    expect(await ensurePackageForms({ caseId: CASE.id, organizationId: ORG })).toBe(0);
    expect(inserted).toHaveLength(0);
  });

  it("still honours an explicit list without consulting the workflow", async () => {
    arrange([[]]);
    const { ensurePackageForms } = await svc();

    const created = await ensurePackageForms({
      caseId: CASE.id,
      organizationId: ORG,
      forms: [{ formCode: "I-601", role: "core" }],
    });

    expect(created).toBe(1);
    expect(inserted.map((f) => f.formCode)).toStrictEqual(["I-601"]);
    expect(caseFilingProfile).not.toHaveBeenCalled();
  });
});

describe("a receipt number is evidence the form was receipted", () => {
  it("moves a form still in preparation to receipted", async () => {
    arrange([[form({ status: "in_preparation" })]]);
    const { updateCaseForm } = await svc();

    await updateCaseForm({
      caseId: CASE.id,
      formCode: "I-485",
      organizationId: ORG,
      patch: { receiptNumber: "MSC2190123456" },
    });

    expect(updated[0].status).toBe("receipted");
  });

  it("does not drag a form back from a later state", async () => {
    // An approved form has moved past receipt. Recording the number after the
    // fact must not undo the approval.
    arrange([[form({ status: "approved" })]]);
    const { updateCaseForm } = await svc();

    await updateCaseForm({
      caseId: CASE.id,
      formCode: "I-485",
      organizationId: ORG,
      patch: { receiptNumber: "MSC2190123456" },
    });

    expect(updated[0].status).toBeUndefined();
  });

  it("respects a status the caller set explicitly", async () => {
    arrange([[form({ status: "in_preparation" })]]);
    const { updateCaseForm } = await svc();

    await updateCaseForm({
      caseId: CASE.id,
      formCode: "I-485",
      organizationId: ORG,
      patch: { receiptNumber: "MSC2190123456", status: "rfe" },
    });

    expect(updated[0].status).toBe("rfe");
  });

  it("is refused on a supporting document", async () => {
    // USCIS issues an I-797C per core form and none for the I-864 — it is
    // adjudicated only as part of the filing it accompanies.
    arrange([[form({ formCode: "I-864", role: "supporting" })]]);
    const { updateCaseForm } = await svc();

    await expect(
      updateCaseForm({
        caseId: CASE.id,
        formCode: "I-864",
        organizationId: ORG,
        patch: { receiptNumber: "MSC2190123456" },
      }),
    ).rejects.toThrow(/supporting document/i);
  });
});

describe("the audit trail distinguishes a status change from an edit", () => {
  it("writes case.form_status_changed with both states", async () => {
    arrange([[form({ status: "ready_to_file" })]]);
    const { updateCaseForm } = await svc();

    await updateCaseForm({
      caseId: CASE.id,
      formCode: "I-485",
      organizationId: ORG,
      patch: { status: "filed", filedDate: "2026-09-01" },
    });

    const event = recordAuditEvent.mock.calls[0][0] as any;
    expect(event.action).toBe("case.form_status_changed");
    expect(event.metadata.previousStatus).toBe("ready_to_file");
    expect(event.metadata.status).toBe("filed");
  });

  it("writes case.form_updated when only a detail changed", async () => {
    arrange([[form({ status: "filed" })]]);
    const { updateCaseForm } = await svc();

    await updateCaseForm({
      caseId: CASE.id,
      formCode: "I-485",
      organizationId: ORG,
      patch: { feeCents: 144_000 },
    });

    expect((recordAuditEvent.mock.calls[0][0] as any).action).toBe("case.form_updated");
  });

  it("writes nothing when the patch changes nothing", async () => {
    arrange([[form({ status: "filed", feeCents: 144_000 })]]);
    const { updateCaseForm } = await svc();

    await updateCaseForm({
      caseId: CASE.id,
      formCode: "I-485",
      organizationId: ORG,
      patch: { status: "filed", feeCents: 144_000 },
    });

    expect(updated).toHaveLength(0);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe("a form that reached USCIS is withdrawn, never deleted", () => {
  it.each(["filed", "receipted", "rfe", "approved", "denied"])(
    "refuses to remove a %s form",
    async (status) => {
      arrange([[form({ status })]]);
      const { removeCaseForm } = await svc();

      await expect(
        removeCaseForm({ caseId: CASE.id, formCode: "I-485", organizationId: ORG }),
      ).rejects.toThrow(/withdrawn/i);
      expect(deleted).toBe(0);
    },
  );

  it("removes one that never left the office", async () => {
    arrange([[form({ status: "in_preparation" })]]);
    const { removeCaseForm } = await svc();

    await removeCaseForm({ caseId: CASE.id, formCode: "I-131", organizationId: ORG });

    expect(deleted).toBe(1);
    expect((recordAuditEvent.mock.calls[0][0] as any).action).toBe("case.form_removed");
  });
});

describe("package progress", () => {
  it("counts approved, not filed, as complete", async () => {
    // The whole point of per-form tracking: filed is progress, approved is
    // done, and an I-765 can be approved long before the I-485 it rides with.
    arrange([
      [
        form({ formCode: "I-130", status: "approved" }),
        form({ formCode: "I-485", status: "filed" }),
        form({ formCode: "I-765", status: "approved" }),
        form({ formCode: "I-131", status: "in_preparation" }),
      ],
    ]);
    const { packageProgress } = await svc();

    const p = await packageProgress(CASE.id, ORG);

    expect(p.approved).toBe(2);
    expect(p.filed).toBe(3);
    expect(p.percentage).toBe(50);
  });

  it("names what is still outstanding", async () => {
    arrange([
      [
        form({ formCode: "I-130", status: "approved" }),
        form({ formCode: "I-131", status: "not_started" }),
        form({ formCode: "I-693", status: "in_preparation" }),
      ],
    ]);
    const { packageProgress } = await svc();

    expect((await packageProgress(CASE.id, ORG)).outstanding).toStrictEqual(["I-131", "I-693"]);
  });

  it("returns forms in filing order, not alphabetical", async () => {
    arrange([
      [
        form({ formCode: "I-765" }),
        form({ formCode: "I-130" }),
        form({ formCode: "I-864", role: "supporting" }),
        form({ formCode: "I-485" }),
      ],
    ]);
    const { listCaseForms } = await svc();

    expect((await listCaseForms(CASE.id, ORG)).map((f) => f.formCode)).toStrictEqual([
      "I-130",
      "I-485",
      "I-765",
      "I-864",
    ]);
  });

  it("puts a form the package does not know at the end", async () => {
    // A firm filing an I-601 waiver should not have it sorted into the middle
    // of a package it is not part of.
    arrange([[form({ formCode: "I-601" }), form({ formCode: "I-485" })]]);
    const { listCaseForms } = await svc();

    expect((await listCaseForms(CASE.id, ORG)).map((f) => f.formCode)).toStrictEqual([
      "I-485",
      "I-601",
    ]);
  });
});
