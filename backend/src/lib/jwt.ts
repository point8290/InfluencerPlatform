import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import type { UserRole } from '../models/user.model';
import { UnauthenticatedError } from './errors';

/**
 * HS256 only. The algorithm is pinned on BOTH sign and verify.
 *
 * Pinning on verify is the security-relevant half: if the algorithm were taken
 * from the token's own header, an attacker could present a token claiming
 * `alg: none` and skip verification entirely, or claim HS256 against a service
 * expecting RS256 and sign with the public key. Naming the accepted algorithm
 * removes both, because the header is then never consulted for that decision.
 */
const ALGORITHM = 'HS256' as const;

/**
 * `role` is carried as a claim for the analytics service's RBAC, which verifies
 * the same token with the same secret. This API itself never reads it: every
 * handler here is scoped to the caller's own rows, whatever their role.
 *
 * A role change takes effect at the user's next login. Tokens already issued
 * keep their old claim until they expire (JWT_EXPIRES_IN) — the usual
 * trade-off of a stateless token, and the reason elevation should be paired
 * with a short expiry in production.
 */
export function signAccessToken(userId: number, role: UserRole = 'member'): string {
  return jwt.sign({ role }, env.jwt.secret, {
    subject: String(userId),
    expiresIn: env.jwt.expiresIn as jwt.SignOptions['expiresIn'],
    algorithm: ALGORITHM,
  });
}

/**
 * Returns the user id carried by a valid token, or throws UnauthenticatedError.
 *
 * Every failure mode — bad signature, expired, malformed, wrong algorithm,
 * non-numeric subject — collapses to the same 401. A caller presenting a bad
 * token learns only that it was rejected, never why.
 */
export function verifyAccessToken(token: string): number {
  let payload: jwt.JwtPayload | string;

  try {
    payload = jwt.verify(token, env.jwt.secret, { algorithms: [ALGORITHM] });
  } catch {
    throw new UnauthenticatedError('Invalid or expired token.');
  }

  if (typeof payload === 'string' || payload.sub === undefined) {
    throw new UnauthenticatedError('Invalid or expired token.');
  }

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new UnauthenticatedError('Invalid or expired token.');
  }

  return userId;
}
