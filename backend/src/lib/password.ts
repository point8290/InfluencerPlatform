import bcrypt from 'bcryptjs';

/**
 * bcrypt cost factor. Each increment doubles the work; 12 is roughly 250ms on
 * current hardware, which is slow enough to make offline cracking expensive and
 * fast enough that a login does not feel stalled.
 */
const COST_FACTOR = 12;

/**
 * bcrypt only considers the first 72 BYTES of input. Anything beyond is
 * silently ignored, which would mean two different passwords opening the same
 * account — someone knowing only the first 72 bytes would not need the rest.
 *
 * Signup makes this unreachable by restricting passwords to at most 64
 * printable-ASCII characters, which is at most 64 bytes.
 *
 * This guard is defence in depth. The rule lives in the validator, but the
 * function that actually depends on it is this one — so a future caller (a
 * password-reset flow, an admin tool, a seeder) that hashes without going
 * through signup validation fails loudly here instead of silently truncating.
 * It throws a plain Error, not an AppError: reaching it is a programming
 * mistake, not bad user input.
 */
const BCRYPT_MAX_INPUT_BYTES = 72;

/**
 * A hash of a random value nobody knows. Used to spend the same ~250ms on a
 * login for an email that does not exist as on one that does — see verifyLogin.
 */
export const DECOY_PASSWORD_HASH =
  '$2b$12$lhzI9PDFiQJG0eTNbmzev.toc1yH.jKuNvP92a4pVk8w2WA/oTyFe';

export async function hashPassword(plainText: string): Promise<string> {
  if (Buffer.byteLength(plainText, 'utf8') > BCRYPT_MAX_INPUT_BYTES) {
    throw new Error(
      `Refusing to hash a password longer than ${BCRYPT_MAX_INPUT_BYTES} bytes: bcrypt ` +
        'would silently truncate it, so two different passwords would open the same ' +
        'account. Validate the password before hashing it.',
    );
  }
  return bcrypt.hash(plainText, COST_FACTOR);
}

/**
 * No length guard here, deliberately. Truncation is only dangerous when
 * STORING a hash; comparing an over-long candidate against an existing hash
 * simply fails to match. Express's default 100kb body limit already caps how
 * much a caller can submit.
 */
export async function verifyPassword(plainText: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainText, hash);
}
