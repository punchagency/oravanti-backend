import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 *
 * @param callback the async function to wrapped
 * @returns an async route handler function with error handling
 */
const asyncWrap = (callback: RequestHandler) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await callback(req, res, next);
    } catch (error: any) {
      next(error);
    }
  };
};

export default asyncWrap;
