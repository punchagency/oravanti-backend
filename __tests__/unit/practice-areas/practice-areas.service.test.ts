import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  BadRequestError,
  NotFoundError,
} from "../../../src/utils/error/app-error";

const mockDb = {
  select: jest.fn(),
};

jest.mock("../../../src/db/client", () => ({
  db: mockDb,
}));

const buildSelectChain = (rows: unknown[]) => {
  const chain: any = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    where: jest.fn(() => Promise.resolve(rows)),
  };
  return chain;
};

describe("practice area utilities", () => {
  const organizationId = "firm-1";

  beforeEach(() => {
    // mockReset, not clearAllMocks: clearing only drops recorded calls and
    // leaves the mockReturnValueOnce queue intact, so a test that consumes
    // fewer selects than it queued poisons the next one. That is how a single
    // stale expectation here produced four failures instead of one.
    mockDb.select.mockReset();
  });

  it("normalizes names by trimming whitespace", async () => {
    const { normalizePracticeAreaName } = await import(
      "../../../src/modules/practice-areas/practice-areas.utils"
    );

    expect(normalizePracticeAreaName("  Immigration  ")).toBe("Immigration");
  });

  it("requires a practiceAreaId before checking subscription access", async () => {
    const { ensurePracticeAreaExists } = await import(
      "../../../src/modules/practice-areas/practice-areas.utils"
    );

    await expect(ensurePracticeAreaExists(organizationId)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when the practice area does not exist", async () => {
    mockDb.select.mockReturnValueOnce(buildSelectChain([]));
    const { ensurePracticeAreaExists } = await import(
      "../../../src/modules/practice-areas/practice-areas.utils"
    );

    await expect(
      ensurePracticeAreaExists(organizationId, "missing-area"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * The subscription gate is commented out in practice-areas.utils.ts behind a
   * TODO ("temporarily disabled until we have a proper subscription management
   * system in place"). Kept as a skip rather than deleted: the rule is intended
   * behaviour that is switched off, and rewriting the assertion to match the
   * gap would turn the test into a rubber stamp that passes whether or not the
   * gate is ever restored. Un-skip with the block in practice-areas.utils.ts.
   */
  it.skip("rejects case setup when the firm has no active subscription", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(buildSelectChain([]));
    const { ensurePracticeAreaExists } = await import(
      "../../../src/modules/practice-areas/practice-areas.utils"
    );

    await expect(
      ensurePracticeAreaExists(organizationId, "area-1"),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("resolves the practice area once it is found to exist", async () => {
    mockDb.select.mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]));
    const { ensurePracticeAreaExists } = await import(
      "../../../src/modules/practice-areas/practice-areas.utils"
    );

    await expect(ensurePracticeAreaExists(organizationId, "area-1")).resolves.toEqual({
      id: "area-1",
    });
    // One query, not two — the second was the subscription lookup, which the
    // skipped test above covers and which is currently disabled.
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("rejects case setup when the case type does not belong to the practice area", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(buildSelectChain([]));
    const { ensureCaseTypeBelongsToPracticeArea } = await import(
      "../../../src/modules/practice-areas/practice-areas.utils"
    );

    await expect(
      ensureCaseTypeBelongsToPracticeArea(organizationId, "area-1", "divorce"),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("allows case setup when the case type belongs to the practice area", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(
        buildSelectChain([
          {
            id: "case-type-1",
            subcategoryId: "subcategory-1",
            code: "h1b_visa",
            name: "H-1B Visa",
            caseNumberPrefix: "H1B",
            jurisdiction: "federal",
          },
        ]),
      );
    const { ensureCaseTypeBelongsToPracticeArea } = await import(
      "../../../src/modules/practice-areas/practice-areas.utils"
    );

    await expect(
      ensureCaseTypeBelongsToPracticeArea(organizationId, "area-1", "h1b_visa"),
    ).resolves.toEqual({
      practiceArea: { id: "area-1" },
      caseType: {
        id: "case-type-1",
        subcategoryId: "subcategory-1",
        code: "h1b_visa",
        name: "H-1B Visa",
        caseNumberPrefix: "H1B",
        jurisdiction: "federal",
      },
    });
  });
});
