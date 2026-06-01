import { describe, expect, it, jest } from "@jest/globals";
import { PracticeAreasController } from "../../../src/resources/practice-areas/practice-areas.controller";

const createResponse = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

describe("PracticeAreasController", () => {
  const organizationId = "firm-1";

  const createController = (service: Record<string, unknown>) =>
    new PracticeAreasController(service as any);

  it("fetches practice areas with search", async () => {
    const result = [{ id: "area-1", name: "Immigration" }];
    const service = {
      getAllPracticeAreas: jest.fn(async () => result),
    };
    const controller = createController(service);
    const res = createResponse();
    const next = jest.fn();

    await controller.getAllPracticeAreas(
      { query: { search: "immi" } } as any,
      res as any,
      next,
    );

    expect(service.getAllPracticeAreas as any).toHaveBeenCalledWith({
      search: "immi",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(result);
    expect(next).not.toHaveBeenCalled();
  });

  it("fetches organization practice areas with search", async () => {
    const result = [{ id: "area-1", name: "Immigration", active: true }];
    const service = {
      getFirmPracticeAreas: jest.fn(async () => result),
    };
    const controller = createController(service);
    const res = createResponse();
    const next = jest.fn();

    await controller.getFirmPracticeAreas(
      { organizationId, query: { search: "immi" } } as any,
      res as any,
      next,
    );

    expect(service.getFirmPracticeAreas as any).toHaveBeenCalledWith(
      organizationId,
      { search: "immi" },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(result);
    expect(next).not.toHaveBeenCalled();
  });

  it("creates subscriptions with a 201 response", async () => {
    const result = { id: "area-1", name: "Immigration" };
    const body = { practiceAreaIds: ["area-1"] };
    const service = {
      createSubscriptions: jest.fn(async () => result),
    };
    const controller = createController(service);
    const res = createResponse();
    const next = jest.fn();

    await controller.createSubscriptions(
      { organizationId, body } as any,
      res as any,
      next,
    );

    expect(service.createSubscriptions as any).toHaveBeenCalledWith(
      organizationId,
      body,
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(result);
    expect(next).not.toHaveBeenCalled();
  });
});
