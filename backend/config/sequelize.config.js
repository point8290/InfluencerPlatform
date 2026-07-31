// Database connection settings for sequelize-cli (migrations and seeders).
//
// The application does NOT read this file — it builds its own Sequelize
// instance in src/config/database.ts. Both read the same environment
// variables, so the environment is the single source of truth and the two
// cannot drift apart. Duplicating six lines is a smaller cost than bridging
// CommonJS and TypeScript to share one object.
require('dotenv').config();

const shared = {
  dialect: 'mysql',
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  logging: false,

  // Record executed seeders in a SequelizeData table, exactly as migrations are
  // recorded in SequelizeMeta. Without this, sequelize-cli's default is to
  // track nothing, so `db:seed:all` would re-run every time and the second run
  // would die on uq_modules_code. Tracking makes seeding idempotent at the
  // tooling level and makes `db:seed:undo:all` meaningful.
  seederStorage: 'sequelize',
};

module.exports = {
  development: {
    ...shared,
    database: process.env.DB_NAME,
  },
  // The test database is a real MySQL schema, not SQLite: the concurrency
  // tests depend on SELECT ... FOR UPDATE row locks, which SQLite does not have.
  test: {
    ...shared,
    database: process.env.DB_NAME_TEST || `${process.env.DB_NAME}_test`,
  },
  production: {
    ...shared,
    database: process.env.DB_NAME,
  },
};
