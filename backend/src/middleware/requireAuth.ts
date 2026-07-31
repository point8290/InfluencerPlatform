import type { Request, RequestHandler } from 'express';
import { verifyAccessToken } from '../lib/jwt';
import { UnauthenticatedError } from '../lib/errors';

const BEARER_PREFIX = 'Bearer ';

/**
 * Rejects any request without a valid token, and attaches the user id.
 *
 * This proves WHO the caller is. It deliberately does not prove what they may
 * see — every handler behind it additionally scopes its query by
 * `authenticatedUserId(req)`, so a valid token for user A can never read user
 * B's wallet, payments or campaigns.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;

  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    next(new UnauthenticatedError('Authorization header must be "Bearer <token>".'));
    return;
  }

  try {
    req.userId = verifyAccessToken(header.slice(BEARER_PREFIX.length).trim());
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Reads the id that requireAuth attached.
 *
 * The throw is unreachable on any route mounted behind requireAuth. It exists
 * so that reading the id never requires a non-null assertion: if this middleware
 * were ever left off a route by mistake, the result is a clean 401 rather than
 * `undefined` silently flowing into a `where` clause and matching nothing — or,
 * worse, matching everything.
 */
export function authenticatedUserId(req: Request): number {
  if (req.userId === undefined) {
    throw new UnauthenticatedError();
  }
  return req.userId;
}
