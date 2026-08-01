import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Prepares the test database once, before any test file runs.
 *
 * THE SCHEMA IS BUILT BY RUNNING THE REAL MIGRATIONS. sequelize.sync() is never
 * called here, for the same reason it is never called in the app: sync builds a
 * schema from the models, so the tests would be validating the models against
 * themselves. The constraints these tests exist to prove —
 * uq_ledger_payment_id, uq_ledger_campaign_id, uq_balances_wallet_currency,
 * chk_ledger_reference_exclusive, uq_payments_user_idempotency_key,
 * CHECK(balance >= 0) — are declared in migrations and nowhere else.
 *
 * The schema is dropped first; tests/helpers/dropTestSchema.ts explains why
 * unwinding migrations and seeders cannot do the job, and why that helper is
 * test-scoped rather than an npm script.
 */
const BACKEND_ROOT = path.resolve(__dirname, '..');

function sequelizeCli(...args: string[]): void {
  execFileSync('npx', ['sequelize-cli', ...args, '--env', 'test'], {
    cwd: BACKEND_ROOT,
    stdio: 'pipe',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV = 'test';

  const startedAt = Date.now();

  // Imported dynamically, AFTER NODE_ENV is set, so database.ts resolves to the
  // test database rather than the development one.
  const { sequelize } = await import('../src/config/database');
  const { dropTestSchema } = await import('./helpers/dropTestSchema');

  try {
    // dropTestSchema refuses any database whose name does not end in "_test",
    // so a mis-set NODE_ENV cannot turn this into a destructive operation.
    await dropTestSchema();
  } finally {
    await sequelize.close();
  }

  sequelizeCli('db:migrate');
  sequelizeCli('db:seed:all');

  console.log(`\n[tests] test schema built from migrations in ${Date.now() - startedAt}ms`);
}
