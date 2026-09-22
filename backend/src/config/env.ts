import path from 'node:path';
import dotenv from 'dotenv';

// Loaded once, at import time. Every module that needs configuration imports
// `env` from here rather than reaching into process.env directly, so there is
// exactly one place a missing variable can be diagnosed — and it fails at boot
// rather than at the moment of first use, deep inside a request.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'Copy backend/.env.example to backend/.env and fill it in.',
    );
  }
  return value;
}

function withDefault(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function intWithDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, received "${raw}".`);
  }
  return parsed;
}

const databaseName = required('DB_NAME');

export type DirectPaymentGatewayName = 'simulated' | 'stripe' | 'disabled';

/**
 * Which gateway the server-driven ("direct") payment flow charges through.
 *
 * 'simulated' grants REAL credits for FAKE money — it exists to exercise the
 * retry machinery against failures a real gateway cannot be made to produce on
 * demand. It is therefore the development default and refused outright in
 * production, where the flow is off unless a real gateway is named.
 */
function directPaymentGateway(nodeEnv: string): DirectPaymentGatewayName {
  const fallback = nodeEnv === 'production' ? 'disabled' : 'simulated';
  const value = withDefault('DIRECT_PAYMENT_GATEWAY', fallback);

  if (value !== 'simulated' && value !== 'stripe' && value !== 'disabled') {
    throw new Error(
      `DIRECT_PAYMENT_GATEWAY must be "simulated", "stripe" or "disabled", received "${value}".`,
    );
  }
  if (value === 'simulated' && nodeEnv === 'production') {
    throw new Error(
      'DIRECT_PAYMENT_GATEWAY=simulated is refused in production: it grants credits without taking money.',
    );
  }
  return value;
}

function nonNegativeInt(name: string, fallback: number): number {
  const value = intWithDefault(name, fallback);
  if (value < 0) {
    throw new Error(`Environment variable ${name} must be zero or more, received ${value}.`);
  }
  return value;
}

const nodeEnv = withDefault('NODE_ENV', 'development');

/**
 * Retry policy for server-driven charges.
 *
 *   PAYMENT_RETRY_DEFAULT_MAX   retries used when a request does not ask for a
 *                               number (retries, not calls: 3 means up to 4 calls)
 *   PAYMENT_RETRY_MAX_CAP       the most a request may ask for — a client must
 *                               not be able to make the server hammer a gateway
 *   PAYMENT_RETRY_BASE_DELAY_MS first backoff; doubles on each retry
 *   PAYMENT_RETRY_MAX_DELAY_MS  ceiling on any single backoff
 */
function retryPolicy() {
  const maxRetriesCap = nonNegativeInt('PAYMENT_RETRY_MAX_CAP', 5);
  const defaultMaxRetries = nonNegativeInt('PAYMENT_RETRY_DEFAULT_MAX', 3);
  if (defaultMaxRetries > maxRetriesCap) {
    throw new Error(
      `PAYMENT_RETRY_DEFAULT_MAX (${defaultMaxRetries}) cannot exceed PAYMENT_RETRY_MAX_CAP (${maxRetriesCap}).`,
    );
  }
  return {
    defaultMaxRetries,
    maxRetriesCap,
    baseDelayMs: nonNegativeInt('PAYMENT_RETRY_BASE_DELAY_MS', 250),
    maxDelayMs: nonNegativeInt('PAYMENT_RETRY_MAX_DELAY_MS', 4000),
  };
}

export const env = {
  nodeEnv,
  port: intWithDefault('PORT', 4000),
  frontendUrl: withDefault('FRONTEND_URL', 'http://localhost:5173'),

  db: {
    host: withDefault('DB_HOST', '127.0.0.1'),
    port: intWithDefault('DB_PORT', 3306),
    name: databaseName,
    // The test suite runs against a separate real MySQL schema — row locks do
    // not exist in SQLite, so the concurrency tests need the real thing.
    nameTest: withDefault('DB_NAME_TEST', `${databaseName}_test`),
    user: required('DB_USER'),
    // A blank password is legitimate on a local MySQL, so this is not `required`.
    password: withDefault('DB_PASSWORD', ''),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: withDefault('JWT_EXPIRES_IN', '7d'),
  },

  directPayments: {
    gateway: directPaymentGateway(nodeEnv),
    retry: retryPolicy(),
  },
} as const;

export const isProduction = env.nodeEnv === 'production';
export const isTest = env.nodeEnv === 'test';

/**
 * Stripe credentials are deliberately NOT validated at boot.
 *
 * Steps 1-3 stand up the schema and authentication before any payment code
 * exists, and a server that refuses to start without keys it does not yet use
 * would be hostile to that build order. They are asserted at first use instead,
 * which still fails loudly and still names the missing variable.
 *
 * The two secrets are asserted SEPARATELY and never together, because they are
 * needed by different code paths at different times:
 *
 *   - the API key is needed to CREATE a Checkout Session;
 *   - the signing secret is needed to VERIFY an incoming webhook, and it does
 *     not even exist until `stripe listen` prints it.
 *
 * Requiring both at once would mean neither path could run without the other —
 * so you could not create a session until you had started a webhook listener
 * you had no session to test with.
 */
export function requireStripeSecretKey(): string {
  return required('STRIPE_SECRET_KEY');
}

export function requireStripeWebhookSecret(): string {
  return required('STRIPE_WEBHOOK_SECRET');
}
