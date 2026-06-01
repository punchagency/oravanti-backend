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
    jest.clearAllMocks();
  });

  it("normalizes names by trimming whitespace", async () => {
    const { normalizePracticeAreaName } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    expect(normalizePracticeAreaName("  Immigration  ")).toBe("Immigration");
  });

  it("requires a practiceAreaId before checking subscription access", async () => {
    const { ensurePracticeAreaExists } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    await expect(ensurePracticeAreaExists(organizationId)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when the practice area does not exist", async () => {
    mockDb.select.mockReturnValueOnce(buildSelectChain([]));
    const { ensurePracticeAreaExists } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    await expect(
      ensurePracticeAreaExists(organizationId, "missing-area"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects case setup when the firm has no active subscription", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(buildSelectChain([]));
    const { ensurePracticeAreaExists } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    await expect(
      ensurePracticeAreaExists(organizationId, "area-1"),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("allows case setup when the practice area exists and the firm is subscribed", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(buildSelectChain([{ id: "subscription-1" }]));
    const { ensurePracticeAreaExists } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    await expect(ensurePracticeAreaExists(organizationId, "area-1")).resolves.toEqual({
      id: "area-1",
    });
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it("rejects case setup when the case type does not belong to the practice area", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(buildSelectChain([{ id: "subscription-1" }]))
      .mockReturnValueOnce(buildSelectChain([]));
    const { ensureCaseTypeBelongsToPracticeArea } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    await expect(
      ensureCaseTypeBelongsToPracticeArea(organizationId, "area-1", "divorce"),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("allows case setup when the case type belongs to the practice area", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(buildSelectChain([{ id: "subscription-1" }]))
      .mockReturnValueOnce(
        buildSelectChain([
          {
            id: "case-type-1",
            code: "h1b_visa",
            name: "H-1B Visa",
            caseNumberPrefix: "H1B",
          },
        ]),
      );
    const { ensureCaseTypeBelongsToPracticeArea } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    await expect(
      ensureCaseTypeBelongsToPracticeArea(organizationId, "area-1", "h1b_visa"),
    ).resolves.toEqual({
      practiceArea: { id: "area-1" },
      caseType: {
        id: "case-type-1",
        code: "h1b_visa",
        name: "H-1B Visa",
        caseNumberPrefix: "H1B",
      },
    });
  });
});
