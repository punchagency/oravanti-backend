import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../src/utils/error/app-error";
import { practiceAreas } from "../../../src/db/schema/practice-areas";

const mockDb = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

jest.mock("../../../src/db/client", () => ({
  db: mockDb,
}));

const buildSelectChain = (rows: unknown[]) => {
  const chain: any = {
    from: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => Promise.resolve(rows)),
    limit: jest.fn(() => Promise.resolve(rows)),
    then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
};

const buildInsertChain = (rows: unknown[]) => {
  const chain: any = {
    values: jest.fn(() => chain),
    returning: jest.fn(() => Promise.resolve(rows)),
  };
  return chain;
};

const buildUpdateChain = (rows: unknown[]) => {
  const chain: any = {
    set: jest.fn(() => chain),
    where: jest.fn(() => chain),
    returning: jest.fn(() => Promise.resolve(rows)),
  };
  return chain;
};

const buildDeleteChain = () => {
  const chain: any = {
    where: jest.fn(() => Promise.resolve(undefined)),
  };
  return chain;
};

describe("practice area service", () => {
  const firmId = "firm-1";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("normalizes names by trimming whitespace", async () => {
    const { normalizePracticeAreaName } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    expect(normalizePracticeAreaName("  Immigration  ")).toBe("Immigration");
  });

  it("requires a practiceAreaId before checking existence", async () => {
    const { ensurePracticeAreaExists } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    await expect(ensurePracticeAreaExists(firmId)).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when the practice area does not belong to the firm", async () => {
    mockDb.select.mockReturnValueOnce(buildSelectChain([]));
    const { ensurePracticeAreaExists } = await import(
      "../../../src/resources/practice-areas/practice-areas.utils"
    );

    await expect(
      ensurePracticeAreaExists(firmId, "missing-area"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("creates a trimmed practice area", async () => {
    const insertChain = buildInsertChain([
      { id: "area-1", firmId, name: "Immigration" },
    ]);
    mockDb.select.mockReturnValueOnce(buildSelectChain([]));
    mockDb.insert.mockReturnValueOnce(insertChain);
    const { createPracticeArea } = await import(
      "../../../src/resources/practice-areas/practice-areas.service"
    );

    const result = await createPracticeArea(firmId, {
      name: "  Immigration  ",
    });

    expect(mockDb.insert).toHaveBeenCalledWith(practiceAreas);
    expect(insertChain.values).toHaveBeenCalledWith({
      firmId,
      name: "Immigration",
    });
    expect(result).toEqual({ id: "area-1", firmId, name: "Immigration" });
  });

  it("rejects duplicate practice area names", async () => {
    mockDb.select.mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]));
    const { createPracticeArea } = await import(
      "../../../src/resources/practice-areas/practice-areas.service"
    );

    await expect(
      createPracticeArea(firmId, { name: "Immigration" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("updates a practice area after confirming it exists and name is available", async () => {
    const updateChain = buildUpdateChain([
      { id: "area-1", firmId, name: "Family Immigration" },
    ]);
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(buildSelectChain([]));
    mockDb.update.mockReturnValueOnce(updateChain);
    const { updatePracticeArea } = await import(
      "../../../src/resources/practice-areas/practice-areas.service"
    );

    const result = await updatePracticeArea("area-1", firmId, {
      name: " Family Immigration ",
    });

    expect(updateChain.set).toHaveBeenCalledWith({
      name: "Family Immigration",
      updatedAt: expect.any(Date),
    });
    expect(result).toEqual({
      id: "area-1",
      firmId,
      name: "Family Immigration",
    });
  });

  it("returns practice area details with mapped cases", async () => {
    mockDb.select
      .mockReturnValueOnce(
        buildSelectChain([{ id: "area-1", firmId, name: "Immigration" }]),
      )
      .mockReturnValueOnce(
        buildSelectChain([
          {
            id: "case-1",
            caseNumber: "2026-FAM-001",
            caseType: "family_petition",
            status: "active",
            priority: "medium",
            filingDate: "2026-05-28",
            caseProgress: 10,
            clientId: "client-1",
            clientFirstName: "Ada",
            clientLastName: "Lovelace",
            assigneeFirstName: "Grace",
            assigneeLastName: "Hopper",
            assigneeRole: "attorney",
          },
        ]),
      );
    const { getPracticeAreaById } = await import(
      "../../../src/resources/practice-areas/practice-areas.service"
    );

    const result = await getPracticeAreaById("area-1", firmId);

    expect(result).toEqual({
      id: "area-1",
      firmId,
      name: "Immigration",
      cases: [
        {
          id: "case-1",
          caseNumber: "2026-FAM-001",
          caseType: "family_petition",
          status: "active",
          priority: "medium",
          filingDate: "2026-05-28",
          caseProgress: 10,
          client: { id: "client-1", name: "Ada Lovelace" },
          assignee: { name: "Grace Hopper", role: "attorney" },
        },
      ],
    });
  });

  it("blocks deleting a practice area with cases", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(buildSelectChain([{ id: "case-1" }]));
    const { deletePracticeArea } = await import(
      "../../../src/resources/practice-areas/practice-areas.service"
    );

    await expect(deletePracticeArea("area-1", firmId)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("deletes a practice area with no cases", async () => {
    const deleteChain = buildDeleteChain();
    mockDb.select
      .mockReturnValueOnce(buildSelectChain([{ id: "area-1" }]))
      .mockReturnValueOnce(buildSelectChain([]));
    mockDb.delete.mockReturnValueOnce(deleteChain);
    const { deletePracticeArea } = await import(
      "../../../src/resources/practice-areas/practice-areas.service"
    );

    await deletePracticeArea("area-1", firmId);

    expect(mockDb.delete).toHaveBeenCalledWith(practiceAreas);
    expect(deleteChain.where).toHaveBeenCalledTimes(1);
  });
});
