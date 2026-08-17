import { describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { validateRequest } from "../../src/middleware/validate.middleware";
import { AppError } from "../../src/utils/error/app-error";

/**
 * Request validation.
 *
 * The reason this has a test at all: it used to report only `issues[0]`, so a
 * caller with three invalid fields fixed one, retried, and was told about the
 * next — three round trips for one mistake — and the log could not say what
 * else had been wrong, because the other issues were discarded at the throw.
 */

const makeReq = (over: Record<string, unknown> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request;

/** Runs the middleware and returns whatever reached next(). */
const validate = (schema: Parameters<typeof validateRequest>[0], req: Request) => {
  const next = jest.fn() as unknown as NextFunction;
  validateRequest(schema)(req, {} as Response, next);

  const call = (next as unknown as jest.Mock).mock.calls[0];
  return { error: call?.[0] as AppError | undefined, req };
};

describe("validateRequest", () => {
  it("passes a valid request through untouched", () => {
    const { error } = validate(
      { body: z.object({ name: z.string() }) },
      makeReq({ body: { name: "Jane" } }),
    );

    expect(error).toBeUndefined();
  });

  it("writes the coerced values back onto the request", () => {
    // Express 5 makes req.query getter-only, so the middleware has to shadow
    // it — a silent failure here means controllers read unparsed strings.
    const { req } = validate(
      { query: z.object({ limit: z.coerce.number() }) },
      makeReq({ query: { limit: "25" } }),
    );

    expect(req.query).toEqual({ limit: 25 });
  });

  describe("a rejection", () => {
    const schema = {
      query: z.object({
        limit: z.coerce.number().max(100),
        page: z.coerce.number().min(1),
        sort: z.enum(["asc", "desc"]),
      }),
    };

    const badRequest = () =>
      validate(schema, makeReq({ query: { limit: "200", page: "0", sort: "sideways" } }));

    it("is a 400", () => {
      const { error } = badRequest();

      expect(error).toBeInstanceOf(AppError);
      expect(error?.statusCode).toBe(400);
      expect(error?.code).toBe("BAD_REQUEST");
    });

    it("reports every field that failed, not just the first", () => {
      const { error } = badRequest();
      const issues = (error?.details as any).issues as Array<{ path: string }>;

      expect(issues.map((i) => i.path).sort()).toEqual(["limit", "page", "sort"]);
    });

    it("carries a message and code per issue", () => {
      const { error } = badRequest();
      const issues = (error?.details as any).issues as Array<Record<string, string>>;

      for (const issue of issues) {
        expect(typeof issue.message).toBe("string");
        expect(issue.message.length).toBeGreaterThan(0);
        expect(typeof issue.code).toBe("string");
      }
    });

    it("names which part of the request was wrong", () => {
      const { error } = badRequest();

      expect((error?.details as any).source).toBe("query");
    });

    it("distinguishes a body failure from a query one", () => {
      const { error } = validate(
        {
          query: z.object({ page: z.coerce.number() }),
          body: z.object({ email: z.string().email() }),
        },
        makeReq({ query: { page: "1" }, body: { email: "not-an-email" } }),
      );

      expect((error?.details as any).source).toBe("body");
    });

    it("keeps the first issue as the summary message", () => {
      const { error } = badRequest();

      expect(error?.message).toBe((error?.details as any).issues[0].message);
    });
  });

  it("passes a non-Zod failure straight through", () => {
    const exploding = z.string().transform(() => {
      throw new TypeError("transform exploded");
    });

    const { error } = validate({ body: exploding }, makeReq({ body: "x" }));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
  });
});
