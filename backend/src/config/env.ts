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

export const env = {
  nodeEnv: withDefault('NODE_ENV', 'development'),
  port: intWithDefault('PORT', 4000),
  frontendUrl: withDefault('FRONTEND_URL', 'http://localhost:5173'),

  db: {
    host: withDefault('DB_HOST', '127.0.0.1'),
    port: intWithDefault('DB_PORT', 3306),
    name: required('DB_NAME'),
    user: required('DB_USER'),
    // A blank password is legitimate on a local MySQL, so this is not `required`.
    password: withDefault('DB_PASSWORD', ''),
  },

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: withDefault('JWT_EXPIRES_IN', '7d'),
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
