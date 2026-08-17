import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { errorMiddleware } from "../../../src/middleware/error.middleware";
import { runWithRequestContext } from "../../../src/middleware/request-context";
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from "../../../src/utils/error/app-error";
import { captureLogs, type LogCapture } from "./capture";

/**
 * The error path (plan-02 step 9, closes H4).
 *
 * Two things are load-bearing. A failure is recorded exactly once, at a level
 * that reflects whether it was our fault or the caller's. And the response
 * never carries the internal error text — a Postgres error names tables,
 * columns and constraints, a driver error names hosts, an AWS error names
 * buckets. The client gets a correlation id to quote instead.
 */

let logs: LogCapture;

const makeReq = (over: Record<string, unknown> = {}): Request =>
  ({
    method: "POST",
    originalUrl: "/api/cases?token=secret-bearer-value",
    baseUrl: "",
    ...over,
  }) as unknown as Request;

const makeRes = () => {
  const res = {
    headersSent: false,
    statusCode: 200,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    body: undefined as any,
  };
  return res;
};

/** Runs the middleware with a known request id bound. */
const handle = (
  error: unknown,
  res = makeRes(),
  next: NextFunction = jest.fn(),
  req: Request = makeReq(),
) => {
  runWithRequestContext({ source: "http", requestId: "req-under-test" }, () =>
    errorMiddleware(error as any, req, res as unknown as Response, next),
  );
  return { res, next };
};

describe("errorMiddleware", () => {
  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  describe("an AppError is the caller's problem", () => {
    it("answers with its own status, code and message", () => {
      const { res } = handle(new NotFoundError("Case not found"));

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.body).toMatchObject({
        success: false,
        code: "NOT_FOUND",
        message: "Case not found",
      });
    });

    it("logs it once, at warn, without a stack", () => {
      handle(new BadRequestError("practiceAreaId is required"));

      const record = logs.only();
      expect(record).toMatchObject({
        level: "warn",
        event: "http.request_rejected",
        domain: "http",
        method: "POST",
        status: 400,
        code: "BAD_REQUEST",
        errorName: "BadRequestError",
        errorMessage: "practiceAreaId is required",
      });
      // A stack through express internals says nothing about why a client sent
      // an invalid payload, and 4xx is the common case by volume.
      expect(record.err).toBeUndefined();
    });

    it("keeps the field-level detail that says which input was wrong", () => {
      handle(
        new ValidationError("Validation failed", {
          fields: { email: "must be an email" },
        } as any),
      );

      expect(logs.only().details).toEqual({
        fields: { email: "must be an email" },
      });
    });
  });

  describe("anything else is ours, and is not disclosed", () => {
    // The shape of a real Drizzle/postgres failure.
    const pgError = () =>
      Object.assign(
        new Error('relation "case_encryption_keys" does not exist at character 42'),
        {
          code: "42P01",
          detail: "column client_dek_wrapped",
          table: "case_encryption_keys",
          constraint: "case_encryption_keys_pkey",
          routine: "parserOpenTable",
        },
      );

    it("replaces the message with a generic one", () => {
      const { res } = handle(pgError());

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.body.message).toBe("Internal server error");
      expect(res.body.code).toBe("INTERNAL_SERVER_ERROR");
    });

    it("leaks neither the table name nor the column name", () => {
      const { res } = handle(pgError());
      const serialised = JSON.stringify(res.body);

      expect(serialised).not.toContain("case_encryption_keys");
      expect(serialised).not.toContain("client_dek_wrapped");
      expect(serialised).not.toContain("does not exist");
    });

    it("logs it once, at error, with the whole error", () => {
      handle(pgError());

      const record = logs.only();
      expect(record).toMatchObject({
        level: "error",
        event: "http.request_failed",
        status: 500,
      });
      // The response says nothing, so this record is the only account of what
      // actually broke — it has to carry the stack.
      expect(record.err.message).toContain("case_encryption_keys");
      expect(record.err.stack).toBeDefined();
    });

    it("pulls the postgres diagnostics onto the record as searchable fields", () => {
      // The difference between "insert failed" and knowing which constraint on
      // which table rejected it. Buried in a stack string, none of this is
      // greppable.
      handle(pgError());

      expect(logs.only()).toMatchObject({
        pgCode: "42P01",
        pg_table: "case_encryption_keys",
        pg_constraint: "case_encryption_keys_pkey",
        pg_detail: "column client_dek_wrapped",
        pg_routine: "parserOpenTable",
      });
    });
  });

  describe("the correlation id", () => {
    it("is on the response, so a user can quote it at support", () => {
      const { res } = handle(new NotFoundError());

      expect(res.body.requestId).toBe("req-under-test");
    });

    it("is on a 500, which is the response that says nothing else", () => {
      const { res } = handle(new Error("boom"));

      expect(res.body.requestId).toBe("req-under-test");
    });

    it("ties the response to the log record", () => {
      const { res } = handle(new Error("boom"));

      expect(logs.only().requestId).toBe(res.body.requestId);
    });
  });

  describe("RLS violations", () => {
    it.each(["42501", "44000"])("turns pg %s into a 403", (code) => {
      const { res } = handle(
        Object.assign(new Error("permission denied"), { code }),
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body).toMatchObject({
        code: "TENANT_ISOLATION_VIOLATION",
        requestId: "req-under-test",
      });
    });

    it("logs its own event — a tenant breach is not a routine 403", () => {
      handle(Object.assign(new Error("permission denied"), { code: "42501" }));

      expect(logs.only()).toMatchObject({
        level: "error",
        event: "security.rls_violation",
        domain: "security",
        pgCode: "42501",
      });
    });
  });

  describe("upload failures", () => {
    it("answers 413 for a file over the limit", () => {
      const { res } = handle(new multer.MulterError("LIMIT_FILE_SIZE"));

      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.body).toMatchObject({
        code: "FILE_TOO_LARGE",
        requestId: "req-under-test",
      });
      expect(logs.only().level).toBe("warn");
    });

    it("answers 400 for any other multer failure", () => {
      const { res } = handle(new multer.MulterError("LIMIT_UNEXPECTED_FILE"));

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.body.code).toBe("UPLOAD_ERROR");
    });
  });

  it("hands the error on when the response has already started", () => {
    // Express's default handler has to take over: the status line is gone, so
    // there is nothing left to answer with, and the socket must be destroyed.
    const res = makeRes();
    res.headersSent = true;
    const next = jest.fn();

    handle(new Error("too late"), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
    expect(logs.records()).toHaveLength(0);
  });

  it("keeps the query string out of the log", () => {
    handle(new NotFoundError());

    const record = logs.only();
    expect(record.path).toBe("/api/cases");
    expect(JSON.stringify(record)).not.toContain("secret-bearer-value");
  });

  it("records the matched route so failures can be grouped", () => {
    handle(
      new NotFoundError(),
      makeRes(),
      jest.fn(),
      makeReq({
        originalUrl: "/api/cases/7f3e0c1a",
        baseUrl: "/api/cases",
        route: { path: "/:id" },
      }),
    );

    expect(logs.only().route).toBe("/api/cases/:id");
  });
});
