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

const toBadRequestError = (error: ZodError) => {
  const issue = error.issues[0];
  return new BadRequestError(issue?.message ?? "Invalid request", {
    path: issue ? formatPath(issue.path) : undefined,
  });
};

export const validateRequest =
  (schema: RequestValidationSchema) =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schema.params) {
        req.params = schema.params.parse(req.params) as typeof req.params;
      }

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

      if (schema.body) {
        req.body = schema.body.parse(req.body);
      }

      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        next(toBadRequestError(error));
        return;
      }

      next(error);
    }
  };
