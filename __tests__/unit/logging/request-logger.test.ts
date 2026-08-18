import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { requestLogger } from "../../../src/middleware/request-logger";
import { runWithRequestContext } from "../../../src/middleware/request-context";
import { tagModule } from "../../../src/middleware/module-context";
import { captureLogs, type LogCapture } from "./capture";

/**
 * Access logging.
 *
 * Assertions are against the records the real drivers emit, not against a mock
 * of the logging API — so redaction and the field envelope are covered by the
 * same test that covers the middleware's decisions.
 */

let logs: LogCapture;

const makeReq = (over: Record<string, unknown> = {}): Request =>
  ({
    method: "GET",
    path: "/api/cases",
    originalUrl: "/api/cases",
    baseUrl: "",
    params: {},
    query: {},
    // The ip and user agent are read off the headers by utils/request-info,
    // shared with the request context — not from express's own `req.ip`.
    headers: { "user-agent": "Mozilla/5.0" },
    socket: { remoteAddress: "203.0.113.7" },
    get: (h: string) =>
      h.toLowerCase() === "user-agent" ? "Mozilla/5.0" : undefined,
    ...over,
  }) as unknown as Request;

const makeRes = (statusCode = 200, headers: Record<string, unknown> = {}) => {
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  (res as any).statusCode = statusCode;
  (res as any).getHeader = (name: string) => headers[name.toLowerCase()];
  return res;
};

/** Runs the middleware and completes the response the way express would. */
const run = (
  req: Request,
  statusCode = 200,
  how: "finish" | "close" | "both" = "both",
  headers: Record<string, unknown> = {},
) => {
  const res = makeRes(statusCode, headers);
  const next = jest.fn();

  requestLogger(req, res as unknown as Response, next);

  if (how === "finish" || how === "both") res.emit("finish");
  if (how === "close" || how === "both") res.emit("close");

  return { next };
};

describe("requestLogger", () => {
  beforeEach(() => {
    // The arrival line is on by default and has its own tests below; switching
    // it off here keeps every only() about the completion line.
    process.env.LOG_REQUEST_ENTRY = "off";
    logs = captureLogs("info");
  });

  afterEach(() => {
    delete process.env.LOG_REQUEST_ENTRY;
    logs.restore();
  });

  it("writes one line per request and passes control on", () => {
    const { next } = run(makeReq());

    expect(next).toHaveBeenCalledTimes(1);
    expect(logs.only()).toMatchObject({
      event: "http.request",
      domain: "http",
      message: "GET /api/cases 200",
    });
  });

  it("records the method, path, status and a duration", () => {
    run(makeReq({ method: "POST" }), 201);

    const record = logs.only();
    expect(record).toMatchObject({
      method: "POST",
      path: "/api/cases",
      status: 201,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0",
      level: "info",
    });
    expect(typeof record.duration_ms).toBe("number");
    expect(record.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("logs exactly once when finish and close both fire", () => {
    // Both events fire on a normal response. Logging on each would double every
    // line in the access log and silently double any rate derived from it.
    run(makeReq(), 200, "both");

    expect(logs.records()).toHaveLength(1);
    expect(logs.only().aborted).toBeUndefined();
  });

  it("marks a request the client abandoned", () => {
    run(makeReq(), 200, "close");

    expect(logs.only().aborted).toBe(true);
  });

  describe("level follows the status", () => {
    it.each([
      [200, "info"],
      [304, "info"],
      [400, "warn"],
      [401, "warn"],
      [429, "warn"],
      [500, "error"],
      [503, "error"],
    ])("logs %i at %s", (status, level) => {
      run(makeReq(), status as number);

      expect(logs.only().level).toBe(level);
    });
  });

  describe("context that makes a request reproducible", () => {
    it("keeps the query parameters", () => {
      // Filters and pagination are most of what distinguishes one request to a
      // list endpoint from another; without them a slow request cannot be
      // reproduced from the log.
      run(makeReq({ query: { status: "open", page: "3", search: "bianchi" } }));

      expect(logs.only().query).toEqual({
        status: "open",
        page: "3",
        search: "bianchi",
      });
    });

    it("redacts a sensitive query value instead of dropping the query", () => {
      run(makeReq({ query: { token: "secret-bearer-value", page: "1" } }));

      const record = logs.only();
      expect(record.query.token).toBe("[REDACTED]");
      expect(record.query.page).toBe("1");
      expect(JSON.stringify(record)).not.toContain("secret-bearer-value");
    });

    it("records the matched route pattern alongside the concrete path", () => {
      // The pattern is the low-cardinality field worth grouping by; the path
      // is what you read back for one specific request.
      run(
        makeReq({
          originalUrl: "/api/cases/7f3e0c1a",
          baseUrl: "/api/cases",
          route: { path: "/:id" },
          params: { id: "7f3e0c1a" },
        }),
      );

      expect(logs.only()).toMatchObject({
        route: "/api/cases/:id",
        path: "/api/cases/7f3e0c1a",
      });
    });

    it("records the response size when the header is set", () => {
      run(makeReq(), 200, "both", { "content-length": "4096" });

      expect(logs.only().bytes).toBe(4096);
    });
  });

  describe("secrets in the path", () => {
    it("masks a token that arrives as a path parameter", () => {
      // /invoice-payment/:token is unauthenticated and the token IS the
      // credential, so an unmasked access log hands anyone with log access the
      // ability to view and pay the invoice.
      run(
        makeReq({
          path: "/invoice-payment/pay_secret_9f2c",
          originalUrl: "/invoice-payment/pay_secret_9f2c",
          baseUrl: "/invoice-payment",
          route: { path: "/:token" },
          params: { token: "pay_secret_9f2c" },
        }),
      );

      const record = logs.only();
      expect(record.path).toBe("/invoice-payment/[REDACTED]");
      expect(record.route).toBe("/invoice-payment/:token");
      expect(JSON.stringify(record)).not.toContain("pay_secret_9f2c");
    });

    it("leaves an ordinary path parameter alone", () => {
      run(
        makeReq({
          originalUrl: "/api/cases/7f3e0c1a",
          baseUrl: "/api/cases",
          route: { path: "/:id" },
          params: { id: "7f3e0c1a" },
        }),
      );

      expect(logs.only().path).toBe("/api/cases/7f3e0c1a");
    });
  });

  describe("health probes", () => {
    // A load balancer hits these every couple of seconds; logged, they would be
    // the bulk of the log by volume and carry nothing.
    it.each(["/health", "/health/live"])("does not log %s", (path) => {
      const { next } = run(makeReq({ path, originalUrl: path }));

      expect(logs.records()).toHaveLength(0);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("still logs a route that merely starts with a probe path", () => {
      run(makeReq({ path: "/health-report", originalUrl: "/health-report" }));

      expect(logs.records()).toHaveLength(1);
    });
  });

  describe("locating the request", () => {
    it("names the API module the request entered", () => {
      runWithRequestContext({ source: "http" }, () => {
        tagModule("/cases")(makeReq(), {} as any, () => {});
        run(makeReq());
      });

      expect(logs.only().apiModule).toBe("cases");
    });

    it("rebuilds the route from the mount path after express has restored baseUrl", () => {
      // express resets req.baseUrl to "" once the router's stack unwinds, so
      // by the time the response finishes a request to /cases reported a bare
      // "/". The mount path recorded by tagModule is what fixes it.
      runWithRequestContext({ source: "http" }, () => {
        tagModule("/cases")(makeReq(), {} as any, () => {});
        run(
          makeReq({
            originalUrl: "/cases",
            baseUrl: "",
            route: { path: "/" },
          }),
        );
      });

      expect(logs.only().route).toBe("/cases");
    });

    it("keeps the parameter in the pattern for a nested route", () => {
      runWithRequestContext({ source: "http" }, () => {
        tagModule("/cases")(makeReq(), {} as any, () => {});
        run(
          makeReq({
            originalUrl: "/cases/7f3e0c1a",
            baseUrl: "",
            route: { path: "/:id" },
            params: { id: "7f3e0c1a" },
          }),
        );
      });

      expect(logs.only().route).toBe("/cases/:id");
    });
  });

  describe("the arrival line", () => {
    // The access log is written on `finish`. A request that hangs, deadlocks or
    // takes the process down never gets there, so without an arrival line the
    // one request you need to see is the only one that leaves no trace.
    beforeEach(() => {
      delete process.env.LOG_REQUEST_ENTRY;
      logs.restore();
      logs = captureLogs("debug");
    });

    it("records the request before the handler runs", () => {
      const res = makeRes(200);
      requestLogger(makeReq(), res as unknown as Response, jest.fn());

      // Nothing has finished the response yet.
      expect(logs.only()).toMatchObject({
        event: "http.request_received",
        level: "info",
        method: "GET",
        path: "/api/cases",
      });
    });

    it("says where the request came from, in the message", () => {
      // Visible without expanding the fields, which is the point of having it.
      run(
        makeReq({
          get: (h: string) =>
            h.toLowerCase() === "origin" ? "https://app.oravanti.com" : undefined,
        }),
      );

      expect(logs.records()[0]!.message).toBe(
        "GET /api/cases from https://app.oravanti.com",
      );
      expect(logs.records()[0]!.origin).toBe("https://app.oravanti.com");
    });

    it("falls back to the client address when there is no origin", () => {
      expect(logs.records()).toHaveLength(0);
      run(makeReq());

      expect(logs.records()[0]!.message).toBe("GET /api/cases from 203.0.113.7");
    });

    it("pairs with the completion line", () => {
      run(makeReq(), 200);

      expect(logs.records().map((r) => r.event)).toEqual([
        "http.request_received",
        "http.request",
      ]);
    });

    it("can be dropped to debug for volume", () => {
      process.env.LOG_REQUEST_ENTRY = "debug";
      logs.restore();
      logs = captureLogs("info");

      run(makeReq(), 200);

      expect(logs.only().event).toBe("http.request");
    });

    it("can be switched off entirely", () => {
      process.env.LOG_REQUEST_ENTRY = "off";

      run(makeReq(), 200);

      expect(logs.only().event).toBe("http.request");
    });

    it("redacts the same fields the completion line does", () => {
      run(makeReq({ query: { token: "secret-bearer-value" } }));

      expect(logs.records()[0]!.query.token).toBe("[REDACTED]");
    });
  });

  it("carries the request's correlation fields without restating them", () => {
    // requestId comes from the bound child logger, not from this middleware —
    // two sources for one field is two chances to disagree.
    runWithRequestContext(
      { source: "http", requestId: "req-abc" },
      () => run(makeReq()),
    );

    expect(logs.only()).toMatchObject({ requestId: "req-abc", source: "http" });
  });
});
