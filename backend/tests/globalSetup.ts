import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Prepares the test database once, before any test file runs.
 *
 * THE SCHEMA IS BUILT BY RUNNING THE REAL MIGRATIONS. sequelize.sync() is never
 * called here, for the same reason it is never called in the app: sync builds a
 * schema from the models, so the tests would be validating the models against
 * themselves. The constraints these tests exist to prove — uq_ledger_payment_id,
 * uq_ledger_campaign_id, uq_balances_wallet_currency, CHECK(balance >= 0) — are
 * declared in migrations and nowhere else.
 *
 * WHY IT DROPS EVERY TABLE FIRST rather than using `db:migrate:undo:all` plus
 * `db:seed:undo:all`:
 *
 * The seeder's down() deletes from `currencies`, but once a test run has left
 * `balances` and `ledger` rows behind, those reference currencies with
 * ON DELETE RESTRICT — so the undo fails on a foreign key. Swallowing that
 * failure leaves the seeder still recorded in SequelizeData, so the subsequent
 * `db:seed:all` reports "No seeders found" and the suite starts against a
 * migrated but COMPLETELY UNSEEDED database. That failure mode is silent and
 * only shows up as every test 500ing on signup.
 *
 * Dropping the schema outright removes the ordering problem entirely: nothing
 * survives to be inconsistent, including SequelizeMeta and SequelizeData.
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

async function dropEverySchemaTable(): Promise<void> {
  // Imported dynamically, AFTER NODE_ENV is set, so database.ts resolves to the
  // test database rather than the development one.
  const { sequelize } = await import('../src/config/database');

  const databaseName = sequelize.getDatabaseName();

  // This function drops every table it can see. The guard is not decoration —
  // without it, a mis-set NODE_ENV would destroy the development schema.
  if (!databaseName.endsWith('_test')) {
    await sequelize.close();
    throw new Error(
      `Refusing to drop tables in "${databaseName}": the name does not end in "_test".`,
    );
  }

  try {
    const [tables] = (await sequelize.query(
      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
    )) as [{ name: string }[], unknown];

    if (tables.length > 0) {
      // Disabled only here, in setup, so no test can pass by writing a row the
      // foreign keys would have rejected.
      await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const table of tables) {
        await sequelize.query(`DROP TABLE IF EXISTS \`${table.name}\``);
      }
      await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
    }
  } finally {
    await sequelize.close();
  }
}

export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV = 'test';

  const startedAt = Date.now();

  await dropEverySchemaTable();

  sequelizeCli('db:migrate');
  sequelizeCli('db:seed:all');

  console.log(`\n[tests] test schema built from migrations in ${Date.now() - startedAt}ms`);
}
