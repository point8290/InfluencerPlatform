import { Balance, Currency, User, Wallet, sequelize } from '../../models';
import {
  DECOY_PASSWORD_HASH,
  MAX_PASSWORD_BYTES,
  hashPassword,
  verifyPassword,
} from '../../lib/password';
import { signAccessToken } from '../../lib/jwt';
import {
  ConflictError,
  InvalidCredentialsError,
  UnauthenticatedError,
  ValidationError,
  type ErrorDetail,
} from '../../lib/errors';
import { isUniqueViolation } from '../../lib/isUniqueViolation';

const MIN_PASSWORD_LENGTH = 8;

/**
 * Deliberately permissive. The only way to truly validate an address is to send
 * mail to it; a stricter regex would reject valid addresses while still not
 * proving deliverability.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PublicUser {
  id: number;
  email: string;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
}

function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email };
}

function readEmail(raw: unknown, details: ErrorDetail[]): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({ field: 'email', message: 'Email is required.' });
    return '';
  }

  // Normalised to lowercase before storage AND before lookup, so the two always
  // agree. The column's utf8mb4_unicode_ci collation already makes
  // uq_users_email case-insensitive, so this is about storing one consistent
  // form rather than about enforcing uniqueness.
  const email = raw.trim().toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    details.push({ field: 'email', message: 'Email is not a valid address.' });
  }
  return email;
}

/**
 * Signup enforces the password policy. Login deliberately does NOT — see
 * validateLoginInput.
 */
export function validateSignupInput(body: unknown): { email: string; password: string } {
  const details: ErrorDetail[] = [];
  const input = (body ?? {}) as Record<string, unknown>;

  const email = readEmail(input.email, details);
  const rawPassword = input.password;
  let password = '';

  if (typeof rawPassword !== 'string' || rawPassword === '') {
    details.push({ field: 'password', message: 'Password is required.' });
  } else {
    password = rawPassword;

    if (password.length < MIN_PASSWORD_LENGTH) {
      details.push({
        field: 'password',
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
    }

    // bcrypt ignores everything past 72 bytes. Accepting a longer password
    // would mean silently truncating it, so two different passwords would open
    // the same account. Rejecting is honest; truncating is not.
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      details.push({
        field: 'password',
        message: `Password must be at most ${MAX_PASSWORD_BYTES} bytes.`,
      });
    }
  }

  if (details.length > 0) {
    throw new ValidationError('Request body failed validation.', details);
  }
  return { email, password };
}

/**
 * Login checks presence only, never the password policy.
 *
 * If the policy were applied here too, raising MIN_PASSWORD_LENGTH later would
 * lock out every existing user whose password was valid when they chose it.
 * Policy belongs at registration; authentication only asks whether the secret
 * matches.
 */
export function validateLoginInput(body: unknown): { email: string; password: string } {
  const details: ErrorDetail[] = [];
  const input = (body ?? {}) as Record<string, unknown>;

  const email = readEmail(input.email, details);
  const rawPassword = input.password;

  if (typeof rawPassword !== 'string' || rawPassword === '') {
    details.push({ field: 'password', message: 'Password is required.' });
  }

  if (details.length > 0) {
    throw new ValidationError('Request body failed validation.', details);
  }
  return { email, password: rawPassword as string };
}

/**
 * Creates the user, their wallet, and one zero balance row per currency — all
 * in a single transaction, so a user can never exist without a fully
 * provisioned wallet.
 *
 * Provisioning every balance row here is what lets every later grant and spend
 * assume the row already exists and is lockable. If balances were created
 * lazily on first use, two concurrent requests could both find no row and both
 * try to create one, and the SELECT ... FOR UPDATE that the whole concurrency
 * design rests on would have nothing to lock.
 *
 * There is NO pre-check for an existing email. uq_users_email is the guarantee,
 * and querying first would only add a time-of-check-to-time-of-use window that
 * two concurrent signups could both pass through.
 */
export async function signup(body: unknown): Promise<AuthResult> {
  const { email, password } = validateSignupInput(body);

  // ~250ms of bcrypt, done before the transaction opens so no database
  // transaction is ever held open across it.
  const passwordHash = await hashPassword(password);

  let user: User;
  try {
    user = await sequelize.transaction(async (transaction) => {
      const currencies = await Currency.findAll({ transaction });

      if (currencies.length === 0) {
        throw new Error(
          'No currencies are seeded — run `npm run seed`. Refusing to create a wallet ' +
            'with no balance rows, because later grants and spends assume they exist.',
        );
      }

      const created = await User.create({ email, passwordHash }, { transaction });
      const wallet = await Wallet.create({ userId: created.id }, { transaction });

      await Balance.bulkCreate(
        currencies.map((currency) => ({
          walletId: wallet.id,
          currencyId: currency.id,
          balance: 0,
        })),
        { transaction },
      );

      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'uq_users_email')) {
      throw new ConflictError('EMAIL_ALREADY_REGISTERED', 'That email is already registered.');
    }
    throw error;
  }

  return { user: toPublicUser(user), token: signAccessToken(user.id) };
}

/**
 * Verifies credentials in constant-ish time.
 *
 * When the email is unknown there is no stored hash to compare against, so the
 * obvious implementation returns immediately — and that speed difference is
 * measurable. It turns login into an oracle for which emails are registered.
 * Comparing against a decoy hash makes both paths pay the same ~250ms.
 */
export async function login(body: unknown): Promise<AuthResult> {
  const { email, password } = validateLoginInput(body);

  // withPassword replaces the model's default scope, which otherwise excludes
  // password_hash from every read.
  const user = await User.scope('withPassword').findOne({ where: { email } });

  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? DECOY_PASSWORD_HASH);

  if (user === null || !passwordMatches) {
    throw new InvalidCredentialsError();
  }

  return { user: toPublicUser(user), token: signAccessToken(user.id) };
}

/**
 * A token can outlive the account it names, so the user is loaded rather than
 * trusted from the token alone.
 */
export async function getCurrentUser(userId: number): Promise<PublicUser> {
  const user = await User.findByPk(userId);

  if (user === null) {
    throw new UnauthenticatedError('This account no longer exists.');
  }
  return toPublicUser(user);
}
