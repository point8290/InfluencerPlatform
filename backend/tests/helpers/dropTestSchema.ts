import { sequelize } from '../../src/config/database';

/**
 * Drops every table in the TEST database, so the schema can be rebuilt from the
 * real migrations before the suite runs.
 *
 * DELIBERATELY TEST-ONLY, AND DELIBERATELY NOT REACHABLE FROM AN npm SCRIPT.
 *
 * There is no `db:drop` or `db:reset` command in package.json, and this file
 * lives under tests/ rather than scripts/ or src/. That is the point: a
 * convenient "wipe the database" command is one mistyped DB_HOST away from
 * destroying real data, and a developer with production credentials in their
 * local .env is not an exotic scenario. Nothing here ships in `dist` either —
 * tsconfig.build.json emits `src` only.
 *
 * The guard below is a NAME check, not an environment check. `NODE_ENV` is
 * absent or wrong far too often to be load-bearing for something destructive;
 * a database called `credits_wallet` can never be mistaken for one called
 * `credits_wallet_test`, whatever the environment claims to be.
 *
 * WHY DROP RATHER THAN UNDO MIGRATIONS AND SEEDERS
 *
 * The obvious reset — `db:seed:undo:all` then `db:migrate:undo:all` — cannot
 * work once the database contains data, and fails two different ways:
 *
 *   - The seeder's down() deletes from `plans` and `currencies`, which
 *     `payments.plan_id` and `ledger.currency_id` reference with
 *     ON DELETE RESTRICT. Any purchase through a bundle makes the undo fail.
 *   - Skipping the seeder undo does not help: `db:migrate:undo:all` drops every
 *     migration-created table but NOT `SequelizeData`, which records executed
 *     seeders. The subsequent `db:seed:all` then reports "No seeders found" and
 *     exits 0, leaving a migrated but completely UNSEEDED database — a silent
 *     failure that surfaces later as every signup returning 500.
 *
 * Dropping outright removes both problems: nothing survives to be inconsistent,
 * including SequelizeMeta and SequelizeData.
 */
export async function dropTestSchema(): Promise<void> {
  const databaseName = sequelize.getDatabaseName();

  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to drop tables in "${databaseName}": the name does not end in "_test". ` +
        'This helper exists only to rebuild the test schema.',
    );
  }

  const [tables] = (await sequelize.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
  )) as [{ name: string }[], unknown];

  if (tables.length === 0) return;

  // Disabled only here, in setup — never inside a test body, so nothing can
  // pass by writing a row the foreign keys would have rejected.
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of tables) {
      await sequelize.query(`DROP TABLE IF EXISTS \`${table.name}\``);
    }
  } finally {
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
