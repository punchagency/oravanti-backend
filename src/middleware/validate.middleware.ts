import { NextFunction, Request, Response } from "express";
import { z, ZodError, ZodType } from "zod";
import { BadRequestError } from "../utils/error/app-error";

type RequestValidationSchema = {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
};

const formatPath = (path: PropertyKey[]) =>
  path.length ? path.map(String).join(".") : undefined;

/** Which part of the request failed to parse. */
type ValidationSource = "params" | "query" | "body";

/**
 * Turns a Zod failure into a client error carrying every problem found.
 *
 * Reporting only `issues[0]` — as this did — means a caller with three invalid
 * fields fixes one, retries, and is told about the next: three round trips for
 * one mistake. It also left the log unable to answer what else was wrong,
 * since the discarded issues are gone by the time the error is caught.
 *
 * `message` stays the first issue so the summary line is short and readable;
 * the full set lives in `details.issues`, which both the response and the log
 * record carry.
 */
const toBadRequestError = (error: ZodError, source: ValidationSource) => {
  const issues = error.issues.map((issue) => ({
    path: formatPath(issue.path),
    code: issue.code,
    message: issue.message,
  }));

  const first = error.issues[0];

  return new BadRequestError(first?.message ?? "Invalid request", {
    source,
    path: first ? formatPath(first.path) : undefined,
    issues,
  } as never);
};

export const validateRequest =
  (schema: RequestValidationSchema) =>
  (req: Request, _res: Response, next: NextFunction) => {
    // Tracks which section is being parsed so the failure can name it — "the
    // query was wrong", not just "something was wrong".
    let source: ValidationSource = "params";

    try {
      if (schema.params) {
        req.params = schema.params.parse(req.params) as typeof req.params;
      }

      source = "query";
      if (schema.query) {
        // Express 5 exposes `query` as a getter-only accessor on the request
        // prototype, so a plain assignment throws ("Cannot set property query
        // ... which has only a getter"). Shadow it with an own data property so
        // controllers still read the parsed/coerced values off req.query.
        Object.defineProperty(req, "query", {
          value: schema.query.parse(req.query),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }

      source = "body";
      if (schema.body) {
        req.body = schema.body.parse(req.body);
      }

      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(toBadRequestError(error, source));
        return;
      }

      next(error);
    }
  };
