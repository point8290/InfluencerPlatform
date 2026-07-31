import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, NotFoundError } from '../lib/errors';
import { isProduction } from '../config/env';

/**
 * Catches requests that matched no route, so they leave through the same error
 * envelope as everything else rather than Express's default HTML page.
 */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError('No route matches this path.'));
};

/**
 * The single place an HTTP error response is constructed.
 *
 * Deliberate errors (AppError) carry their own code and status. Anything else
 * is a bug: it is logged in full and returned as a bare INTERNAL_ERROR, because
 * an unexpected exception's message may contain internals that should not be
 * handed to a client.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  console.error('[unhandled]', err);

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      details: [],
      // Surfaced outside production only, to keep local debugging bearable.
      ...(isProduction ? {} : { debug: err instanceof Error ? err.message : String(err) }),
    },
  });
};
