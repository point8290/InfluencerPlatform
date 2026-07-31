// Database connection settings for sequelize-cli (migrations and seeders).
//
// The application never reads this file — it builds its own Sequelize instance
// in src/config/database.ts. Both now derive their connection settings from the
// SAME place: src/config/env.ts.
//
// This file stays CommonJS because sequelize-cli `require()`s it directly and
// cannot consume a TypeScript default export. It can still require a .ts module
// because .sequelizerc registers ts-node BEFORE the CLI loads this file, so
// env.ts is compiled on the fly.
//
// Reading env.ts rather than process.env directly buys three things:
//   - one parser, so `DB_PORT=abc` fails the same way for the CLI as for the app
//     (previously the CLI silently produced NaN);
//   - one validation path, so `npm run migrate` with DB_NAME unset fails naming
//     the variable instead of connecting to a database literally called
//     "undefined";
//   - no duplicated defaults that can drift apart.
const { env } = require('../src/config/env');

const shared = {
  dialect: 'mysql',
  host: env.db.host,
  port: env.db.port,
  username: env.db.user,
  password: env.db.password,
  logging: false,

  // CLI-only concern, with no counterpart in the application: record executed
  // seeders in a SequelizeData table, exactly as migrations are recorded in
  // SequelizeMeta. Without it sequelize-cli tracks nothing, so `db:seed:all`
  // would re-run every time and the second run would die on uq_modules_code.
  // Tracking makes seeding idempotent and makes `db:seed:undo:all` meaningful.
  seederStorage: 'sequelize',
};

module.exports = {
  development: { ...shared, database: env.db.name },
  test: { ...shared, database: env.db.nameTest },
  production: { ...shared, database: env.db.name },
};
