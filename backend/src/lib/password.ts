import bcrypt from 'bcryptjs';

/**
 * bcrypt cost factor. Each increment doubles the work; 12 is roughly 250ms on
 * current hardware, which is slow enough to make offline cracking expensive and
 * fast enough that a login does not feel stalled.
 */
const COST_FACTOR = 12;

/**
 * bcrypt only considers the first 72 BYTES of input. A longer password is
 * silently truncated, which would mean two different passwords authenticating
 * the same account. Signup rejects anything longer rather than truncating
 * quietly — see validateCredentials in the auth service.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * A hash of a random value nobody knows. Used to spend the same ~250ms on a
 * login for an email that does not exist as on one that does — see verifyLogin.
 */
export const DECOY_PASSWORD_HASH =
  '$2b$12$lhzI9PDFiQJG0eTNbmzev.toc1yH.jKuNvP92a4pVk8w2WA/oTyFe';

export async function hashPassword(plainText: string): Promise<string> {
  return bcrypt.hash(plainText, COST_FACTOR);
}

export async function verifyPassword(plainText: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainText, hash);
}
