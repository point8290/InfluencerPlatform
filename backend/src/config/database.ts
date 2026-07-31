import { Sequelize } from 'sequelize';
import { env, isProduction } from './env';

/**
 * The application's Sequelize instance.
 *
 * The schema is owned entirely by the migrations in backend/migrations.
 * `sequelize.sync()` is never called — not here, not in tests, not in a helper
 * script. Sync would let the models silently invent a schema that the
 * migrations never produced, which is exactly the drift the assignment's
 * "migrations, not sync()" requirement exists to prevent.
 */
export const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: 'mysql',

  // Query logging is useful while tracing transactions and row locks by hand,
  // and noise everywhere else.
  logging: isProduction || env.nodeEnv === 'test' ? false : console.log,

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
