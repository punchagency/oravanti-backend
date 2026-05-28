import { describe, expect, it, jest } from "@jest/globals";
import { NotFoundError } from "../../../src/utils/error/app-error";
import { PracticeAreasController } from "../../../src/resources/practice-areas/practice-areas.controller";

const createResponse = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

describe("PracticeAreasController", () => {
  const firmId = "firm-1";

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
      { firmId, query: { search: "immi" } } as any,
      res as any,
      next,
    );

    expect(service.getAllPracticeAreas as any).toHaveBeenCalledWith(firmId, {
      search: "immi",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(result);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes NotFoundError to next when details are missing", async () => {
    const service = {
      getPracticeAreaById: jest.fn(async () => null),
    };
    const controller = createController(service);
    const res = createResponse();
    const next = jest.fn();

    await controller.getPracticeAreaById(
      { firmId, params: { id: "missing-area" } } as any,
      res as any,
      next,
    );

    expect(service.getPracticeAreaById as any).toHaveBeenCalledWith(
      "missing-area",
      firmId,
    );
    expect(next).toHaveBeenCalledWith(expect.any(NotFoundError));
    expect(res.status).not.toHaveBeenCalled();
  });

  it("creates practice areas with a 201 response", async () => {
    const result = { id: "area-1", name: "Immigration" };
    const body = { name: "Immigration" };
    const service = {
      createPracticeArea: jest.fn(async () => result),
    };
    const controller = createController(service);
    const res = createResponse();
    const next = jest.fn();

    await controller.createPracticeArea(
      { firmId, body } as any,
      res as any,
      next,
    );

    expect(service.createPracticeArea as any).toHaveBeenCalledWith(
      firmId,
      body,
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(result);
  });
});
