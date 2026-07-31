import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 does not forward rejected promises to the error handler — an async
 * route that throws would hang the request instead. This wraps an async handler
 * so a rejection reaches `next()`, and therefore the central error handler.
 *
 * Express 5 does this natively; the explicit wrapper is kept because it is
 * eight readable lines rather than framework behaviour you have to already know.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
