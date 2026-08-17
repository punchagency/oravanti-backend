import { describe, expect, it, jest } from "@jest/globals";
import { PracticeAreasController } from "../../../src/modules/practice-areas/practice-areas.controller";
import { runWithRequestContext } from "../../../src/middleware/request-context";

const createResponse = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

/**
 * Runs a handler with an organization bound to the request context.
 *
 * The controller reads organizationId from AsyncLocalStorage, not from `req` —
 * passing it as a request property (as these tests once did) is silently
 * ignored and the service is called with undefined.
 */
const withOrg = <T>(organizationId: string, fn: () => Promise<T>) =>
  runWithRequestContext({ source: "http", organizationId }, fn);

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

    await withOrg(organizationId, () =>
      controller.getAllPracticeAreas(
        { query: { search: "immi" } } as any,
        res as any,
        next,
      ),
    );

    expect(service.getAllPracticeAreas as any).toHaveBeenCalledWith({
      search: "immi",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: "Practice areas retrieved successfully",
      data: result,
    });
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

    await withOrg(organizationId, () =>
      controller.getFirmPracticeAreas(
        { query: { search: "immi" } } as any,
        res as any,
        next,
      ),
    );

    expect(service.getFirmPracticeAreas as any).toHaveBeenCalledWith(
      organizationId,
      { search: "immi" },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: "Firm practice areas retrieved successfully",
      data: result,
    });
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

    await withOrg(organizationId, () =>
      controller.createSubscriptions({ body } as any, res as any, next),
    );

    expect(service.createSubscriptions as any).toHaveBeenCalledWith(
      organizationId,
      body,
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: "Subscriptions created successfully",
      data: result,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("hands a service failure to next() rather than throwing", async () => {
    // asyncWrap is the only thing standing between a rejected service promise
    // and an unhandled rejection that takes the process down.
    const failure = new Error("service exploded");
    const service = {
      getAllPracticeAreas: jest.fn(async () => {
        throw failure;
      }),
    };
    const controller = createController(service);
    const res = createResponse();
    const next = jest.fn();

    await withOrg(organizationId, () =>
      controller.getAllPracticeAreas({ query: {} } as any, res as any, next),
    );

    expect(next).toHaveBeenCalledWith(failure);
    expect(res.json).not.toHaveBeenCalled();
  });
});
