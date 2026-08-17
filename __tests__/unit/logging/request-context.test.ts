import { describe, expect, it, jest } from "@jest/globals";
import type { Request, Response } from "express";
import {
  getRequestContext,
  requestContextMiddleware,
  runWithRequestContext,
} from "../../../src/middleware/request-context";
import { correlationFields } from "../../../src/lib/logging/service-logger";

/**
 * Request correlation (plan-02 step 8).
 *
 * One id ties the access log, every diagnostic line, and every audit row to a
 * single user action. These tests cover the two things that would quietly
 * break that: an id that is not stable for the request, and an inbound id
 * trusted without checking.
 */

type MockRes = Response & { headers: Record<string, string> };

const makeReq = (headers: Record<string, string> = {}): Request =>
  ({
    headers,
    socket: { remoteAddress: "10.0.0.1" },
  }) as unknown as Request;

const makeRes = (): MockRes => {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    on: jest.fn(),
  } as unknown as MockRes;
};

/** Runs the middleware and returns the context observed inside it. */
const capture = (headers: Record<string, string> = {}) => {
  const res = makeRes();
  let seen: ReturnType<typeof getRequestContext> | undefined;
  requestContextMiddleware(makeReq(headers), res, () => {
    seen = getRequestContext();
  });
  return { context: seen!, res };
};

describe("requestContextMiddleware", () => {
  it("generates a request id and echoes it on the response", () => {
    const { context, res } = capture();

    expect(context.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(res.headers["x-request-id"]).toBe(context.requestId);
  });

  it("marks the source as http and captures ip and user agent", () => {
    const { context } = capture({ "user-agent": "Mozilla/5.0" });

    expect(context.source).toBe("http");
    expect(context.ipAddress).toBe("10.0.0.1");
    expect(context.userAgent).toBe("Mozilla/5.0");
    expect(context.actorType).toBe("anonymous");
  });

  it("prefers the first x-forwarded-for entry over the socket address", () => {
    const { context } = capture({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });

    expect(context.ipAddress).toBe("203.0.113.7");
  });

  it("honours a well-formed inbound x-request-id so callers can correlate", () => {
    const { context, res } = capture({ "x-request-id": "upstream-abc_123.4" });

    expect(context.requestId).toBe("upstream-abc_123.4");
    expect(res.headers["x-request-id"]).toBe("upstream-abc_123.4");
  });

  describe("rejects an untrustworthy inbound id", () => {
    // The header is attacker-controlled and lands in every log line for the
    // request. Anything that is not a short opaque token is discarded.
    it.each([
      ["a newline, which forges a second log record", "abc\ninjected"],
      ["a carriage return", "abc\r\nLevel=fatal"],
      ["json-breaking quotes", 'abc","level":"fatal'],
      ["over-long input", "x".repeat(129)],
      ["an empty value", ""],
      ["a space", "abc def"],
    ])("discards %s", (_label, value) => {
      const { context } = capture({ "x-request-id": value });

      expect(context.requestId).not.toBe(value);
      expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it("accepts an inbound id of exactly the length limit", () => {
    const atLimit = "y".repeat(128);
    const { context } = capture({ "x-request-id": atLimit });

    expect(context.requestId).toBe(atLimit);
  });

  it("truncates an absurd user agent rather than logging it whole", () => {
    const { context } = capture({ "user-agent": "u".repeat(4000) });

    expect(context.userAgent).toHaveLength(512);
  });

  it("keeps one id for the whole request", () => {
    const res = makeRes();
    const ids: string[] = [];
    requestContextMiddleware(makeReq(), res, () => {
      ids.push(getRequestContext().requestId);
      ids.push(getRequestContext().requestId);
    });

    expect(ids[0]).toBe(ids[1]);
  });
});

describe("outside a request", () => {
  it("reports a stable process id rather than a fresh one per call", () => {
    // A new id per call would make every unbound line look like its own
    // request, silently breaking the grouping the id exists for.
    const first = getRequestContext().requestId;
    const second = getRequestContext().requestId;

    expect(first).toBe(second);
    expect(first).toMatch(/^process-/);
  });
});

describe("runWithRequestContext", () => {
  it("gives non-http work its own id and source", () => {
    const seen = runWithRequestContext({ source: "queue" }, () =>
      getRequestContext(),
    );

    expect(seen.source).toBe("queue");
    expect(seen.requestId).not.toMatch(/^process-/);
  });

  it("carries an originating request id through so async work stays correlated", () => {
    const seen = runWithRequestContext(
      { source: "queue", requestId: "req-from-http" },
      () => getRequestContext(),
    );

    expect(seen.requestId).toBe("req-from-http");
  });

  it("accepts an explicit actor, instead of writing a null one as today", () => {
    const seen = runWithRequestContext(
      { source: "cli", actorType: "system", actorName: "backfill-script" },
      () => getRequestContext(),
    );

    expect(seen.actorType).toBe("system");
    expect(seen.actorName).toBe("backfill-script");
  });
});

describe("correlationFields", () => {
  it("binds the identifiers a log line needs", () => {
    const fields = runWithRequestContext(
      { source: "http", requestId: "req_1" },
      () => {
        const ctx = getRequestContext();
        ctx.userId = "user_1";
        ctx.organizationId = "org_1";
        ctx.staffId = "staff_1";
        ctx.actorType = "staff";
        return correlationFields(ctx);
      },
    );

    expect(fields).toEqual({
      requestId: "req_1",
      source: "http",
      userId: "user_1",
      orgId: "org_1",
      staffId: "staff_1",
      actorType: "staff",
    });
  });

  it("omits what is not yet known instead of binding nulls", () => {
    const fields = runWithRequestContext(
      { source: "http", requestId: "req_2" },
      () => correlationFields(getRequestContext()),
    );

    expect(fields).toEqual({ requestId: "req_2", source: "http" });
  });

  it("never binds the DEK", () => {
    const fields = runWithRequestContext({ source: "http" }, () => {
      const ctx = getRequestContext();
      ctx.rawUserDEK = Buffer.from("KEY_MATERIAL");
      return correlationFields(ctx);
    });

    expect(JSON.stringify(fields)).not.toContain("KEY_MATERIAL");
    expect(fields).not.toHaveProperty("rawUserDEK");
  });
});
