import { sequelize } from '../../src/config/database';

/**
 * Tables holding per-user data, emptied between tests.
 *
 * Deliberately excludes modules, currencies and plans: those are seeded
 * CONFIGURATION, and the funding path resolves the spend currency through
 * them. Wiping them would break every test in a confusing way.
 *
 * SequelizeMeta and SequelizeData are excluded too — deleting them would make
 * the tooling believe the schema was never migrated.
 */
const USER_DATA_TABLES = ['ledger', 'balances', 'payments', 'campaigns', 'wallets', 'users'];

/**
 * Empties user data between tests.
 *
 * FOREIGN_KEY_CHECKS is disabled around the truncation rather than deleting in
 * dependency order. That is safe here precisely BECAUSE it is scoped to
 * teardown: it never runs inside a test, so no test can accidentally pass by
 * writing a row the foreign keys would have rejected. Doing it this way also
 * means adding a table to the list later cannot silently break ordering.
 *
 * TRUNCATE also resets AUTO_INCREMENT, so ids start at 1 in every test and
 * failures are readable.
 */
export async function resetUserData(): Promise<void> {
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const table of USER_DATA_TABLES) {
      await sequelize.query(`TRUNCATE TABLE \`${table}\``);
    }
  } finally {
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}

/** Closes the pool so Jest can exit cleanly. */
export async function closeDatabase(): Promise<void> {
  await sequelize.close();
}

/**
 * Guard against the tests ever pointing at the development database.
 *
 * resetUserData() truncates every user table, so running it against the wrong
 * schema would destroy real data. Called once per suite.
 */
export function assertUsingTestDatabase(): void {
  const name = sequelize.getDatabaseName();
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against database "${name}" — the name does not end in "_test". ` +
        'These tests truncate every user table. Run them with NODE_ENV=test.',
    );
  }
}
