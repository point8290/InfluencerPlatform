import { Sequelize } from 'sequelize';
import { env, isProduction, isTest } from './env';

/**
 * The database this process talks to.
 *
 * Selected by NODE_ENV so the test suite can never touch development data —
 * the tests delete every user, wallet, payment and ledger row between cases,
 * which would be destructive against the wrong schema. `npm test` sets
 * NODE_ENV=test, and sequelize-cli picks the same database through the `test`
 * block of config/sequelize.config.js, which reads the same env.db.nameTest.
 */
const databaseName = isTest ? env.db.nameTest : env.db.name;

/**
 * The application's Sequelize instance.
 *
 * The schema is owned entirely by the migrations in backend/migrations.
 * `sequelize.sync()` is never called — not here, not in tests, not in a helper
 * script. Sync would let the models silently invent a schema that the
 * migrations never produced, which is exactly the drift the assignment's
 * "migrations, not sync()" requirement exists to prevent.
 */
export const sequelize = new Sequelize(databaseName, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: 'mysql',

  // Query logging is useful while tracing transactions and row locks by hand,
  // and noise everywhere else.
  logging: isProduction || isTest ? false : console.log,

  define: {
    // Columns are snake_case (created_at, wallet_id) to match the migrations.
    underscored: true,
    // Belt and braces alongside the explicit `tableName` on every model:
    // Sequelize's automatic pluralization never gets a chance to guess.
    freezeTableName: true,
    timestamps: true,
  },

  pool: {
    max: 10,
    min: 0,
    idle: 10_000,
    acquire: 30_000,
  },
});
